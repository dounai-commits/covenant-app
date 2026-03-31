const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));  // serve frontend

// ── Database ──
const db = new Database(path.join(__dirname, 'covenant.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS circles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    emoji TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    FOREIGN KEY (circle_id) REFERENCES circles(id)
  );

  CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reward INTEGER NOT NULL,
    punish INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (circle_id) REFERENCES circles(id)
  );

  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    circle_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('comply','violate')),
    note TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (circle_id) REFERENCES circles(id),
    FOREIGN KEY (rule_id) REFERENCES rules(id),
    FOREIGN KEY (reporter_id) REFERENCES members(id),
    FOREIGN KEY (target_id) REFERENCES members(id)
  );
`);

// ── Helpers ──
function uid() { return crypto.randomBytes(8).toString('hex'); }
function inviteCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function now() { return Date.now(); }

function periodStart(period) {
  const d = new Date();
  if (period === 'day') { d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (period === 'week') {
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === 'month') { return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
  return 0; // all
}

// ── Routes ──

// POST /api/circles  创建圈子
app.post('/api/circles', (req, res) => {
  const { circleName, nickname, emoji } = req.body;
  if (!circleName || !nickname) return res.status(400).json({ error: '缺少参数' });

  const circleId = uid();
  const memberId = uid();
  const code = inviteCode();
  const ts = now();

  db.prepare('INSERT INTO circles VALUES (?,?,?,?)').run(circleId, circleName, code, ts);
  db.prepare('INSERT INTO members VALUES (?,?,?,?,?)').run(memberId, circleId, nickname, emoji || '😊', ts);

  res.json({ circleId, memberId, inviteCode: code, circleName });
});

// POST /api/circles/join  加入圈子
app.post('/api/circles/join', (req, res) => {
  const { inviteCode: code, nickname, emoji } = req.body;
  if (!code || !nickname) return res.status(400).json({ error: '缺少参数' });

  const circle = db.prepare('SELECT * FROM circles WHERE invite_code = ?').get(code.toUpperCase());
  if (!circle) return res.status(404).json({ error: '邀请码无效' });

  const memberId = uid();
  db.prepare('INSERT INTO members VALUES (?,?,?,?,?)').run(memberId, circle.id, nickname, emoji || '😊', now());

  res.json({ circleId: circle.id, memberId, inviteCode: circle.invite_code, circleName: circle.name });
});

// GET /api/circles/:code  获取圈子信息
app.get('/api/circles/:code', (req, res) => {
  const circle = db.prepare('SELECT * FROM circles WHERE invite_code = ?').get(req.params.code.toUpperCase());
  if (!circle) return res.status(404).json({ error: '圈子不存在' });

  const members = db.prepare('SELECT * FROM members WHERE circle_id = ? ORDER BY joined_at').all(circle.id);
  const rules = db.prepare('SELECT * FROM rules WHERE circle_id = ? ORDER BY created_at').all(circle.id);

  res.json({ circle, members, rules });
});

// POST /api/rules  新增公约
app.post('/api/rules', (req, res) => {
  const { circleId, title, reward, punish, memberId } = req.body;
  if (!circleId || !title) return res.status(400).json({ error: '缺少参数' });

  // 验证成员属于该圈子
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND circle_id = ?').get(memberId, circleId);
  if (!member) return res.status(403).json({ error: '无权操作' });

  const ruleId = uid();
  db.prepare('INSERT INTO rules VALUES (?,?,?,?,?,?)').run(ruleId, circleId, title, reward || 3, punish || -3, now());

  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId);
  res.json(rule);
});

// POST /api/records  提交行为记录
app.post('/api/records', (req, res) => {
  const { circleId, ruleId, reporterId, targetId, type, note } = req.body;
  if (!circleId || !ruleId || !reporterId || !targetId || !type) {
    return res.status(400).json({ error: '缺少参数' });
  }

  // 验证 reporter 属于圈子
  const reporter = db.prepare('SELECT * FROM members WHERE id = ? AND circle_id = ?').get(reporterId, circleId);
  if (!reporter) return res.status(403).json({ error: '无权操作' });

  const recordId = uid();
  db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)').run(
    recordId, circleId, ruleId, reporterId, targetId, type, note || '', now()
  );

  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  res.json(record);
});

// GET /api/circles/:code/leaderboard?period=all|day|week|month  积分榜
app.get('/api/circles/:code/leaderboard', (req, res) => {
  const circle = db.prepare('SELECT * FROM circles WHERE invite_code = ?').get(req.params.code.toUpperCase());
  if (!circle) return res.status(404).json({ error: '圈子不存在' });

  const period = req.query.period || 'all';
  const start = periodStart(period);

  const members = db.prepare('SELECT * FROM members WHERE circle_id = ?').all(circle.id);
  const rules = db.prepare('SELECT * FROM rules WHERE circle_id = ?').all(circle.id);
  const ruleMap = Object.fromEntries(rules.map(r => [r.id, r]));

  const records = db.prepare(
    'SELECT * FROM records WHERE circle_id = ? AND created_at >= ? ORDER BY created_at DESC'
  ).all(circle.id, start);

  // 计算每人积分
  const scoreMap = {};
  members.forEach(m => { scoreMap[m.id] = 0; });
  records.forEach(r => {
    const rule = ruleMap[r.rule_id];
    if (!rule) return;
    scoreMap[r.target_id] = (scoreMap[r.target_id] || 0) + (r.type === 'comply' ? rule.reward : rule.punish);
  });

  const leaderboard = members
    .map(m => ({ ...m, score: scoreMap[m.id] || 0, recordCount: records.filter(r => r.target_id === m.id).length }))
    .sort((a, b) => b.score - a.score);

  res.json({ period, leaderboard });
});

// GET /api/members/:memberId/records  某人历史记录
app.get('/api/members/:memberId/records', (req, res) => {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.memberId);
  if (!member) return res.status(404).json({ error: '成员不存在' });

  const records = db.prepare(`
    SELECT rec.*, r.title as rule_title, r.reward, r.punish,
           m.nickname as reporter_name
    FROM records rec
    JOIN rules r ON rec.rule_id = r.id
    JOIN members m ON rec.reporter_id = m.id
    WHERE rec.target_id = ?
    ORDER BY rec.created_at DESC
  `).all(req.params.memberId);

  res.json({ member, records });
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`🏠 合租互助公约服务已启动: http://localhost:${PORT}`);
  console.log(`📦 数据库: ${path.join(__dirname, 'covenant.db')}`);
});
