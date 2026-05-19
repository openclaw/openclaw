/**
 * SQLite WAL 資料庫初始化模組
 *
 * 使用 better-sqlite3 同步 API 建立並初始化 nuwa.db，
 * 包含 WAL 模式、外鍵約束、FTS5 全文搜尋等設定。
 *
 * 每個進程維護兩個 DB 實例：
 *   local  — <stateDir>/nuwa.db   （插件工作目錄）
 *   global — ~/.nuwa/nuwa.db      （跨工作區共享）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// ── 公開型別 ────────────────────────────────────────────────────────────────

export interface NuwaDb {
  local: Database.Database; // <stateDir>/nuwa.db
  global: Database.Database; // ~/.nuwa/nuwa.db
}

// ── PRAGMA 設定 ──────────────────────────────────────────────────────────────

/**
 * 套用 WAL 模式與效能 PRAGMA
 * 必須在每個 DB 實例建立後立即呼叫
 */
export function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma("foreign_keys = ON");
}

// ── DDL 遷移 ─────────────────────────────────────────────────────────────────

const DDL_TABLES = `
-- patterns 表：學習模式紀錄（從 patterns.jsonl 遷移）
CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  mental_models TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  context TEXT NOT NULL DEFAULT '',
  skill_path TEXT,
  frozen INTEGER NOT NULL DEFAULT 0,
  last_used TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 繼承樹：父 pattern 的 slug（子 pattern 繼承父的心智模型與 Prompt 權重）
  parent_slug TEXT,
  -- 雙庫策略：local=工作區專屬 / global=跨工作區共享 / shared=已晉升全域
  scope TEXT NOT NULL DEFAULT 'local',
  -- REM 衰減分數：1.0=熱，每晚 Croner 衰減 -2%/天閒置，Croner 更新
  decay_score REAL NOT NULL DEFAULT 1.0,
  -- 最後一次被激活的時間（activate_pattern 工具呼叫時更新）
  last_activated TEXT
);

-- stem_cells 表：幹細胞（從 cell-registry.json 遷移）
CREATE TABLE IF NOT EXISTS stem_cells (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'embryo',
  maturity_score REAL NOT NULL DEFAULT 0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  positive_rating REAL NOT NULL DEFAULT 0,
  last_evaluated TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- learning_events 表：學習事件記錄流
CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  pattern_slug TEXT,
  cell_slug TEXT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  source TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pattern_slug) REFERENCES patterns(slug) ON DELETE SET NULL,
  FOREIGN KEY (cell_slug) REFERENCES stem_cells(slug) ON DELETE SET NULL
);

-- feedback 表：使用者回饋記錄
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  pattern_slug TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pattern_slug) REFERENCES patterns(slug) ON DELETE CASCADE
);

-- causal_edges 表：時序雙時態因果圖（借鑑 Zep graphiti 設計）
-- valid_from/valid_to 記錄事件時間，recorded_at 記錄系統寫入時間
CREATE TABLE IF NOT EXISTS causal_edges (
  id TEXT PRIMARY KEY,
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_by TEXT,
  FOREIGN KEY (superseded_by) REFERENCES causal_edges(id) ON DELETE SET NULL
);

-- pattern_versions 表：版本快照（Croner 每月壓縮用）
CREATE TABLE IF NOT EXISTS pattern_versions (
  id TEXT PRIMARY KEY,
  pattern_slug TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  version_tag TEXT,
  snapshotted_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pattern_slug) REFERENCES patterns(slug) ON DELETE CASCADE
);

-- conversations 表：對話記憶環（壓縮摘要，300字精華）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  summary TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]',
  topic TEXT,
  embedding BLOB,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 角色對話擴充欄位
  role_assignments TEXT NOT NULL DEFAULT '{}',   -- { "claude": "CTO", "user": "Engineer" }
  dialogue_mode TEXT NOT NULL DEFAULT 'normal'   -- "normal" | "role-play" | "debate" | "interview"
);

-- debates 表：代理討論歷程（完整保留，供事後分析）
CREATE TABLE IF NOT EXISTS debates (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  task TEXT NOT NULL,
  rounds TEXT NOT NULL DEFAULT '[]',
  rounds_json TEXT NOT NULL DEFAULT '[]',   -- JSON 格式完整輪次紀錄（新版）
  final_answer TEXT,
  participants TEXT NOT NULL DEFAULT '["claude","codex","openclaw"]',
  convergence_score REAL,
  rounds_count INTEGER NOT NULL DEFAULT 0,
  stopped_by TEXT,                           -- "convergence" | "variance" | "max_rounds"
  pattern_slugs_used TEXT DEFAULT '[]',      -- JSON 陣列，被激活的 pattern slugs
  estimated_cost_usd REAL DEFAULT 0,         -- 費用估算
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  completed_at TEXT,                         -- 完成時間（與 ended_at 並存）
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

-- personas 表：角色定義（角色對話系統 + EvoAgentX 演化）
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,             -- "strict-cto" / "junior-dev" / "pm-challenger"
  name TEXT NOT NULL,                    -- "嚴格 CTO"
  description TEXT NOT NULL,             -- 角色描述（注入 system prompt）
  style TEXT,                            -- "嚴格" / "創意" / "保守"
  focus TEXT,                            -- 關注點（技術/商業/使用者體驗）
  base_pattern_slug TEXT,                -- 繼承的 nuwa pattern（心智模型）
  agent_type TEXT NOT NULL DEFAULT 'claude',   -- 預設由哪個代理扮演
  fitness_score REAL NOT NULL DEFAULT 0.5,     -- EvoAgentX 適應度分數（0-1）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (base_pattern_slug) REFERENCES patterns(slug) ON DELETE SET NULL
);

-- dialogue_turns 表：對話輪次（含角色資訊）
CREATE TABLE IF NOT EXISTS dialogue_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  speaker TEXT NOT NULL,                 -- "claude" / "codex" / "openclaw" / "user"
  persona_slug TEXT,                     -- 扮演的角色 slug（可為 null）
  content TEXT NOT NULL,
  role_context TEXT,                     -- 注入的角色 system prompt 片段
  tokens_used INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_slug) REFERENCES personas(slug) ON DELETE SET NULL
);

-- constitution_principles 表：憲法原則庫（取代硬編碼 CONSTITUTION_MAP）
-- 原則從 seed-constitution.jsonl 初始載入，Hermes 學習後動態調整 weight
CREATE TABLE IF NOT EXISTS constitution_principles (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,               -- "architecture" / "security" / "cost_optimization"
  principle TEXT NOT NULL,              -- 原則內容
  weight REAL NOT NULL DEFAULT 1.0,     -- 有效性權重（causal_edges 學習結果同步）
  win_count INTEGER NOT NULL DEFAULT 0, -- 被採納為有效批評的次數
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_type, principle)
);
`;

const DDL_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_patterns_slug ON patterns(slug);
CREATE INDEX IF NOT EXISTS idx_patterns_target ON patterns(target);
CREATE INDEX IF NOT EXISTS idx_patterns_scope ON patterns(scope);
CREATE INDEX IF NOT EXISTS idx_patterns_decay ON patterns(decay_score);
CREATE INDEX IF NOT EXISTS idx_patterns_parent ON patterns(parent_slug);
CREATE INDEX IF NOT EXISTS idx_stem_cells_status ON stem_cells(status);
CREATE INDEX IF NOT EXISTS idx_learning_events_pattern ON learning_events(pattern_slug);
CREATE INDEX IF NOT EXISTS idx_learning_events_recorded ON learning_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_causal_edges_from ON causal_edges(from_slug);
CREATE INDEX IF NOT EXISTS idx_causal_edges_to ON causal_edges(to_slug);
CREATE INDEX IF NOT EXISTS idx_causal_edges_valid ON causal_edges(valid_from, valid_to);
CREATE INDEX IF NOT EXISTS idx_debates_conv ON debates(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_personas_slug ON personas(slug);
CREATE INDEX IF NOT EXISTS idx_personas_fitness ON personas(fitness_score);
CREATE INDEX IF NOT EXISTS idx_personas_agent_type ON personas(agent_type);
CREATE INDEX IF NOT EXISTS idx_dialogue_turns_conv ON dialogue_turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dialogue_turns_persona ON dialogue_turns(persona_slug);
CREATE INDEX IF NOT EXISTS idx_constitution_task_type ON constitution_principles(task_type);
CREATE INDEX IF NOT EXISTS idx_constitution_weight ON constitution_principles(task_type, weight DESC);
`;

// FTS5 全文搜尋虛擬表（content table 模式，避免資料重複儲存）
const DDL_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(
  slug, target, context, keywords,
  content='patterns', content_rowid='rowid'
);
`;

/**
 * 執行所有 DDL 遷移（表、索引、FTS5）
 * 使用 execTransaction 包裹以確保原子性
 */
export function runMigrations(db: Database.Database): void {
  // 以 transaction 包裹，確保 schema 要嘛全部建立、要嘛全部回滾
  db.transaction(() => {
    db.exec(DDL_TABLES);
    db.exec(DDL_INDEXES);
    // FTS5 在部分環境可能未編譯，靜默跳過
    try {
      db.exec(DDL_FTS);
    } catch {
      // pre-v1 保護層：FTS5 不可用時不中斷啟動
    }
  })();
}

// ── 主要導出函數 ──────────────────────────────────────────────────────────────

/**
 * 開啟（或建立）local 與 global 兩個 DB 實例，
 * 套用 PRAGMA 並執行 schema 遷移。
 *
 * @param stateDir 插件工作目錄（存放 local DB）
 */
export function openDb(stateDir: string): NuwaDb {
  // 確保 local 目錄存在
  fs.mkdirSync(stateDir, { recursive: true });

  // 確保 global 目錄存在
  const globalDir = path.join(os.homedir(), ".nuwa");
  fs.mkdirSync(globalDir, { recursive: true });

  const localPath = path.join(stateDir, "nuwa.db");
  const globalPath = path.join(globalDir, "nuwa.db");

  const local = new Database(localPath);
  const globalDb = new Database(globalPath);

  // 嘗試載入 sqlite-vec extension（向量搜尋，pre-v1 可選）
  for (const db of [local, globalDb]) {
    try {
      // sqlite-vec 若已安裝則自動啟用，否則靜默跳過
      db.loadExtension("vec0");
    } catch {
      // 靜默跳過，不影響核心功能
    }
    applyPragmas(db);
    runMigrations(db);
  }

  return { local, global: globalDb };
}
