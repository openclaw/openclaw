// Quick bench: classification stability + keyword recall
// Usage: OPENCLAW_STATE_DIR=/tmp/sm-bench npx tsx test/bench-classify-recall.ts [--model gemma2:27b] [--samples 50] [--ollama-url http://localhost:11434]

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// ── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "gemma2:27b";
const sampleCount = args.includes("--samples") ? Number(args[args.indexOf("--samples") + 1]) : 50;
const ollamaUrl = args.includes("--ollama-url")
  ? args[args.indexOf("--ollama-url") + 1]
  : "http://localhost:11434";
const stateDir = process.env.OPENCLAW_STATE_DIR ?? "/tmp/sm-bench-state";

// ── Test data: 50 Chinese conversation snippets ────────────
const SAMPLES = [
  "用户说他每天早上6点起床跑步",
  "用户说他在杭州工作了5年",
  "用户提到他最喜欢的食物是川菜",
  "用户说他下周要去北京出差",
  "用户觉得最近工作压力太大了",
  "用户说他妈妈下个月生日",
  "用户提到他不喜欢吃香菜",
  "用户昨天跟老板吵了一架",
  "用户打算明年买房",
  "用户说他大学学的是计算机",
  "用户觉得AI行业未来5年会爆发",
  "用户说他养了一只猫叫咪咪",
  "用户计划这个周末去爬山",
  "用户说他老婆喜欢吃甜食",
  "用户觉得开会很浪费时间",
  "用户说他每天要喝三杯咖啡",
  "用户上个月去了日本旅游",
  "用户说他会说三种语言",
  "用户觉得远程办公效率更高",
  "用户说他孩子今年上小学了",
  "用户提到他喜欢听古典音乐",
  "用户说他最近睡得不好",
  "用户打算下周开始健身",
  "用户说他最讨厌开会迟到的人",
  "用户觉得现在的房租太贵了",
  "用户说他每周六都会打篮球",
  "用户昨天看了个电影觉得很好看",
  "用户说他老板很苛刻",
  "用户觉得学英语很重要",
  "用户说他明天要交一个重要的报告",
  "用户说他喜欢吃火锅但怕辣",
  "用户上周跟朋友去了酒吧",
  "用户说他小时候在农村长大",
  "用户觉得坐地铁比开车方便",
  "用户说他有一个弟弟在上海工作",
  "用户说他每天早上空腹喝柠檬水",
  "用户觉得冬天太冷了受不了",
  "用户说他买了辆新能源车",
  "用户说他从来不吃早餐",
  "用户觉得写代码比写文档有趣",
  "用户说他手机经常没电",
  "用户打算今年学会游泳",
  "用户说他最喜欢的颜色是蓝色",
  "用户觉得这个项目延期是甲方的锅",
  "用户说他每天给自己做便当",
  "用户说他的抽屉里堆满了没用的东西",
  "用户觉得朋友借钱不还很难开口要",
  "用户说他家的洗衣机坏了三个月了",
  "用户昨天退税退了三千块很开心",
  "用户说他公司的IT部门效率很低",
].slice(0, sampleCount);

const QUERIES = [
  { query: "运动 健身", expectedKeywords: "basketball 篮球 sports 跑步 健身" },
  { query: "食物 饮食", expectedKeywords: "hotpot 火锅 川菜 香菜 甜食 便当 咖啡" },
  { query: "旅行", expectedKeywords: "japan 日本 北京 出差 爬山 旅游" },
  { query: "工作", expectedKeywords: "work 开会 老板 跳槽 报告 加班 压力" },
  { query: "家庭", expectedKeywords: "妈妈 老婆 孩子 弟弟 生日" },
  { query: "金钱 理财", expectedKeywords: "买房 房租 退税 借钱" },
  { query: "猫咪 宠物", expectedKeywords: "cat 咪咪 pet" },
  { query: "学习 技能", expectedKeywords: "英语 游泳 学 大学 计算机" },
  { query: "习惯", expectedKeywords: "早起 咖啡 空腹 柠檬水 不吃早餐 喝水 便当" },
  { query: "计划", expectedKeywords: "买房 健身 下个月 明年 下周 计划" },
  { query: "情绪", expectedKeywords: "开心 吵架 讨厌 压力 受不了 讨厌" },
  { query: "房屋 家电", expectedKeywords: "房租 买房 洗衣机 抽屉" },
];

// ── Data structures ────────────────────────────────────────
interface ClassificationResult {
  type: string;
  importance: number;
  confidence: number;
  summary_refined: string;
  keywords: string;
}

interface MemoryRecord {
  id: string;
  type: string;
  summary: string;
  keywords: string;
}

// ── Ollama API call ────────────────────────────────────────
function buildClassificationPrompt(rawText: string): string {
  return `You are a memory classification assistant. Analyze the following text and classify it into a structured memory record.

Classify into ONE of these types:
- fact: A factual statement or piece of knowledge
- event: Something that happened at a point in time
- plan: A future intention, goal, or plan
- impression: A subjective opinion, feeling, or assessment
- preference: A stated like, dislike, or preference
- rule: A conditional rule or constraint

Assign an importance score (1-10) where:
10 = Critical, must remember (identity, core goals, safety rules)
7-9 = Very important (key preferences, recurring patterns)
4-6 = Moderately important (contextual details)
1-3 = Minor (trivia, passing remarks)

Assign a confidence score (0.0-1.0) based on how clearly the text conveys this information.

Also refine the summary to be concise (100 chars or fewer) and extract key space-separated lowercase keywords.

Respond ONLY with a valid JSON:
{"type": "...","importance": 5,"confidence": 0.8,"summary_refined": "...","keywords": "..."}

Text:
${rawText}`;
}

async function callOllama(prompt: string): Promise<string> {
  const resp = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1 } }),
  });
  const json = (await resp.json()) as { response: string };
  return json.response ?? "";
}

function parseClassificationResponse(raw: string): ClassificationResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let jsonStr = trimmed;
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];
  try {
    const parsed = JSON.parse(jsonStr);
    if (
      !parsed.type ||
      !parsed.summary_refined ||
      typeof parsed.importance !== "number" ||
      typeof parsed.confidence !== "number"
    )
      return null;
    const validTypes = ["fact", "event", "plan", "impression", "preference", "rule"];
    if (!validTypes.includes(parsed.type)) return null;
    return {
      type: parsed.type,
      importance: Math.max(1, Math.min(10, Math.round(parsed.importance))),
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      summary_refined: String(parsed.summary_refined).slice(0, 100),
      keywords: String(parsed.keywords ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    };
  } catch {
    return null;
  }
}

// ── Simple SQLite (no openclaw SDK for standalone bench) ──
function openBenchDb(): { db: DatabaseSync; close: () => void } {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSync;
  };
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, "bench.sqlite");
  if (existsSync(dbPath)) unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE memory_records (
    id TEXT PRIMARY KEY, type TEXT, summary TEXT, confidence REAL, importance INTEGER,
    salience REAL DEFAULT 0.5, status TEXT DEFAULT 'active', created_at TEXT, updated_at TEXT,
    last_accessed_at TEXT, expire_at TEXT, contradiction_flag INTEGER DEFAULT 0,
    content TEXT, keywords TEXT, agent_id TEXT, source_session_id TEXT, attributes TEXT DEFAULT '{}')`);
  return {
    db,
    close: () => {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
    },
  };
}

function insertBenchRecord(
  db: DatabaseSync,
  r: ClassificationResult & { raw: string; id: string; agentId: string },
): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO memory_records (id, type, summary, confidence, importance, salience, status, created_at, updated_at, keywords, agent_id, content) VALUES (?,?,?,?,?,0.5,'active',?,?,?,?,?)`,
  );
  stmt.run(
    r.id,
    r.type,
    r.summary_refined,
    r.confidence,
    r.importance,
    now,
    now,
    r.keywords,
    r.agentId,
    r.raw,
  );
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const start = Date.now();

  // ── Phase 1: Classify & Insert ──────────────────────────
  console.log(`\n── Phase 1: Classify ${SAMPLES.length} samples (model: ${model}) ──`);
  const { db, close: closeDb } = openBenchDb();

  let ok = 0;
  let fail = 0;
  const records: MemoryRecord[] = [];

  for (let i = 0; i < SAMPLES.length; i++) {
    const text = SAMPLES[i];
    const prompt = buildClassificationPrompt(text);
    const raw = await callOllama(prompt);
    const result = parseClassificationResponse(raw);

    if (result) {
      ok++;
      const id = `bench-${i}`;
      insertBenchRecord(db, { ...result, raw: text, id, agentId: "bench" });
      records.push({
        id,
        type: result.type,
        summary: result.summary_refined,
        keywords: result.keywords,
      });
    } else {
      fail++;
      console.log(`  FAIL [${i}]: "${text.slice(0, 30)}..." → raw: ${raw.slice(0, 80)}`);
    }
    process.stdout.write(`\r  ${i + 1}/${SAMPLES.length} (ok=${ok} fail=${fail})`);
  }
  console.log(
    `\n  Classification: ${ok}/${SAMPLES.length} ok, ${fail} failed (${((ok / SAMPLES.length) * 100).toFixed(1)}%)`,
  );

  // ── Phase 2: Keyword Recall ──────────────────────────────
  console.log(`\n── Phase 2: Recall (${QUERIES.length} queries) ──`);

  for (const q of QUERIES) {
    const terms = q.query.split(/\s+/);
    const conditions = terms.map(() => "keywords LIKE ?");
    const allStmt = db.prepare(
      `SELECT id, type, summary, keywords FROM memory_records WHERE status='active' AND (${conditions.join(" OR ")}) ORDER BY importance DESC LIMIT 5`,
    );
    const rows = allStmt.all(...terms.map((t) => `%${t}%`)) as unknown as Array<{
      id: string;
      type: string;
      summary: string;
      keywords: string;
    }>;
    const found = rows.map((r) => r.summary);
    console.log(`  Query "${q.query}": found ${rows.length} → ${found.join(" / ")}`);
  }

  closeDb();
  console.log(`\n── Done in ${((Date.now() - start) / 1000).toFixed(1)}s ──`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
