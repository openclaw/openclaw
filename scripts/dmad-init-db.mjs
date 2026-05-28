#!/usr/bin/env node
/**
 * dmad-init-db.mjs — 初始化 nuwa.db 完整 schema + 種子資料
 * 純 JS，使用 sql.js fallback，不依賴 better-sqlite3 原生編譯
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDb } from "./lib/sqlite-compat.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1")),
  "..",
);
const DB_PATH = path.join(
  REPO_ROOT,
  "extensions",
  "evolution-learning",
  ".claude",
  "evolution-state",
  "nuwa.db",
);
const SEED_DIR = path.join(REPO_ROOT, "extensions", "evolution-learning");

async function main() {
  // 確保目錄存在
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  console.log(`Opening: ${DB_PATH}`);
  const db = await openDb(DB_PATH, { readonly: false, fileMustExist: false });

  // ── 1. 建表 ──
  const tables = [
    `CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      target TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      success_rate REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      mental_models TEXT NOT NULL DEFAULT '[]',
      keywords TEXT NOT NULL DEFAULT '[]',
      context TEXT,
      skill_path TEXT,
      frozen INTEGER NOT NULL DEFAULT 0,
      last_used TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      parent_slug TEXT,
      scope TEXT DEFAULT 'local',
      decay_score REAL NOT NULL DEFAULT 1.0,
      last_activated TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS stem_cells (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      source TEXT,
      context TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      promoted_to TEXT,
      status TEXT DEFAULT 'embryo'
    )`,
    `CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      pattern_slug TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      source TEXT,
      recorded_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      summary TEXT,
      dialogue_mode TEXT DEFAULT 'normal',
      started_at TEXT,
      ended_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS debates (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      rounds_json TEXT,
      final_answer TEXT,
      convergence_score REAL,
      rounds_count INTEGER,
      stopped_by TEXT,
      pattern_slugs_used TEXT,
      estimated_cost_usd REAL,
      started_at TEXT,
      completed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS causal_edges (
      id TEXT PRIMARY KEY,
      from_slug TEXT NOT NULL,
      to_slug TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'learned',
      weight REAL NOT NULL DEFAULT 0.5,
      evidence TEXT,
      valid_from TEXT DEFAULT (datetime('now')),
      valid_to TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      pattern_slug TEXT,
      score REAL,
      comment TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS pattern_versions (
      id TEXT PRIMARY KEY,
      pattern_slug TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      snapshot TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const ddl of tables) {
    db.prepare(ddl).run();
  }
  console.log(`Tables created: ${tables.length}`);

  // FTS5 — sql.js 可能不支援，try/catch
  try {
    db.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(
      slug, target, context, keywords, mental_models,
      content=patterns, content_rowid=rowid
    )`).run();
    console.log("FTS5 patterns_fts created");
  } catch (err) {
    console.log("FTS5 不可用（sql.js 可能不含 FTS5 擴充），跳過:", String(err).slice(0, 80));
  }

  // ── 2. 種子資料 ──
  const existingCount = db.prepare("SELECT count(*) as c FROM patterns").get();
  if (existingCount && existingCount.c > 0) {
    console.log(`Patterns 表已有 ${existingCount.c} 筆資料，跳過種子載入`);
  } else {
    let seeded = 0;

    // 載入 seed-constitution.jsonl
    const constitutionPath = path.join(SEED_DIR, "seed-constitution.jsonl");
    if (fs.existsSync(constitutionPath)) {
      const lines = fs.readFileSync(constitutionPath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          db.prepare(`INSERT OR IGNORE INTO patterns
            (id, slug, target, confidence, mental_models, keywords, context, scope, decay_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            p.id ?? randomUUID(),
            p.slug,
            p.target ?? p.slug,
            p.confidence ?? 0.5,
            JSON.stringify(p.mentalModels ?? p.mental_models ?? []),
            JSON.stringify(p.keywords ?? []),
            p.context ?? "",
            p.scope ?? "local",
            p.decayScore ?? p.decay_score ?? 1.0,
          );
          seeded++;
        } catch {
          /* skip bad lines */
        }
      }
      console.log(`Seeded ${seeded} patterns from seed-constitution.jsonl`);
    }

    // 載入 seed-personas.jsonl
    const personasPath = path.join(SEED_DIR, "seed-personas.jsonl");
    if (fs.existsSync(personasPath)) {
      let personaCount = 0;
      const lines = fs.readFileSync(personasPath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const p = JSON.parse(line);
          db.prepare(`INSERT OR IGNORE INTO patterns
            (id, slug, target, confidence, mental_models, keywords, context, scope, decay_score)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            p.id ?? randomUUID(),
            p.slug ?? `persona-${personaCount}`,
            p.target ?? p.name ?? p.slug,
            p.confidence ?? 0.3,
            JSON.stringify(p.mentalModels ?? p.mental_models ?? []),
            JSON.stringify(p.keywords ?? []),
            p.context ?? p.description ?? "",
            "local",
            0.8,
          );
          personaCount++;
        } catch {
          /* skip */
        }
      }
      console.log(`Seeded ${personaCount} patterns from seed-personas.jsonl`);
      seeded += personaCount;
    }

    if (seeded === 0) {
      // 最小種子 — 確保 DMAD 有東西可查
      const fallbackPatterns = [
        {
          slug: "code-quality",
          target: "程式碼品質提升",
          mental_models: ["重構", "測試覆蓋", "SOLID"],
        },
        {
          slug: "system-reliability",
          target: "系統穩定性",
          mental_models: ["容錯", "監控", "回退機制"],
        },
        {
          slug: "learning-loop",
          target: "學習閉環",
          mental_models: ["反饋循環", "模式辨識", "增量改進"],
        },
      ];
      for (const p of fallbackPatterns) {
        db.prepare(`INSERT OR IGNORE INTO patterns
          (id, slug, target, confidence, mental_models, context, scope, decay_score)
          VALUES (?, ?, ?, 0.5, ?, '', 'local', 1.0)`).run(
          randomUUID(),
          p.slug,
          p.target,
          JSON.stringify(p.mental_models),
        );
      }
      console.log(`Seeded ${fallbackPatterns.length} fallback patterns`);
    }
  }

  // ── 3. 驗證 ──
  const finalTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const patternCount = db.prepare("SELECT count(*) as c FROM patterns").get();

  console.log("\n=== 初始化完成 ===");
  console.log("表:", finalTables.map((t) => t.name).join(", "));
  console.log("Patterns:", patternCount?.c ?? 0);

  db.close();
  console.log("Done.");
}

main().catch((err) => {
  console.error("初始化失敗:", err);
  process.exitCode = 1;
});
