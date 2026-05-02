import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { MemoryRecord, RecordFindFilters, RecordType } from "./types";

type SqliteDatabase = DatabaseSync;

const agentDbMap = new Map<string, SqliteDatabase>();

function resolveDbDir(stateDir: string): string {
  return path.join(stateDir, "structured-memory");
}

function resolveDbPath(stateDir: string, agentId: string): string {
  return path.join(resolveDbDir(stateDir), `${agentId}.sqlite`);
}

function ensureSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      importance INTEGER NOT NULL DEFAULT 5,
      salience REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      expire_at TEXT,
      contradiction_flag INTEGER NOT NULL DEFAULT 0,
      allow_coexistence INTEGER NOT NULL DEFAULT 0,
      content TEXT,
      keywords TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL,
      source_session_id TEXT,
      attributes TEXT NOT NULL DEFAULT '{}'
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_status ON memory_records(status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_type ON memory_records(type)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_agent_id ON memory_records(agent_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_records_expire ON memory_records(expire_at)
  `);

  // Phase 1 schema additions (ALTER TABLE for backwards compat)
  const addColumn = (col: string) => {
    try {
      db.exec(col);
    } catch {
      // column already exists — ignore
    }
  };
  addColumn(`ALTER TABLE memory_records ADD COLUMN critical INTEGER NOT NULL DEFAULT 0`);
  addColumn(`ALTER TABLE memory_records ADD COLUMN activate_at TEXT`);
  addColumn(`ALTER TABLE memory_records ADD COLUMN consolidation_count INTEGER NOT NULL DEFAULT 0`);
}

export function getOrOpenDatabase(agentId: string): SqliteDatabase {
  const stateDir = resolveStateDir();
  const cacheKey = `${stateDir}::${agentId}`;
  const existing = agentDbMap.get(cacheKey);
  if (existing) return existing;

  const dbDir = resolveDbDir(stateDir);
  const dbPath = resolveDbPath(stateDir, agentId);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension: false });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");

  ensureSchema(db);
  agentDbMap.set(cacheKey, db);
  return db;
}

export function closeDatabase(agentId: string): void {
  const stateDir = resolveStateDir();
  const cacheKey = `${stateDir}::${agentId}`;
  const db = agentDbMap.get(cacheKey);
  if (db) {
    db.close();
    agentDbMap.delete(cacheKey);
  }
}

export function closeAllDatabases(): void {
  for (const db of agentDbMap.values()) {
    db.close();
  }
  agentDbMap.clear();
}

function castRow(row: unknown): MemoryRecord {
  const obj = row as Record<string, unknown>;
  return {
    id: String(obj.id ?? ""),
    type: obj.type as MemoryRecord["type"],
    summary: String(obj.summary ?? ""),
    confidence: Number(obj.confidence ?? 0),
    importance: Number(obj.importance ?? 0),
    salience: Number(obj.salience ?? 0),
    status: obj.status as MemoryRecord["status"],
    created_at: String(obj.created_at ?? ""),
    updated_at: String(obj.updated_at ?? ""),
    last_accessed_at: typeof obj.last_accessed_at === "string" ? obj.last_accessed_at : null,
    expire_at: typeof obj.expire_at === "string" ? obj.expire_at : null,
    contradiction_flag: obj.contradiction_flag === 1 ? 1 : 0,
    allow_coexistence: obj.allow_coexistence === 1 ? 1 : 0,
    critical: obj.critical === 1 ? 1 : 0,
    activate_at: typeof obj.activate_at === "string" ? obj.activate_at : null,
    consolidation_count: Number(obj.consolidation_count ?? 0),
    content: typeof obj.content === "string" ? obj.content : null,
    keywords: String(obj.keywords ?? ""),
    agent_id: String(obj.agent_id ?? ""),
    source_session_id: typeof obj.source_session_id === "string" ? obj.source_session_id : null,
    attributes: String(obj.attributes ?? "{}"),
  };
}

export function insertRecord(
  db: SqliteDatabase,
  record: {
    id?: string;
    type: string;
    summary: string;
    confidence?: number;
    importance: number;
    salience?: number;
    status?: string;
    expire_at?: string | null;
    activate_at?: string | null;
    critical?: 0 | 1;
    allow_coexistence?: 0 | 1;
    content?: string | null;
    keywords: string;
    agent_id: string;
    source_session_id?: string | null;
    attributes?: string;
  },
): string {
  const id = record.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO memory_records
      (id, type, summary, confidence, importance, salience, status, created_at, updated_at,
       last_accessed_at, expire_at, contradiction_flag, allow_coexistence, critical, activate_at,
       consolidation_count, content, keywords, agent_id,
       source_session_id, attributes)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    record.type,
    record.summary,
    record.confidence ?? 0.3,
    record.importance,
    record.salience ?? Math.max(0, Math.min(1, record.importance / 10)),
    record.status ?? "active",
    now,
    now,
    null,
    record.expire_at ?? null,
    0,
    record.allow_coexistence ?? 0,
    record.critical ?? 0,
    record.activate_at ?? null,
    0,
    record.content ?? null,
    record.keywords,
    record.agent_id,
    record.source_session_id ?? null,
    record.attributes ?? "{}",
  );
  return id;
}

export function updateRecord(
  db: SqliteDatabase,
  id: string,
  fields: {
    summary?: string;
    confidence?: number;
    importance?: number;
    salience?: number;
    keywords?: string;
    content?: string | null;
    expire_at?: string | null;
    activate_at?: string | null;
    critical?: 0 | 1;
    allow_coexistence?: 0 | 1;
    attributes?: string;
    status?: string;
  },
): boolean {
  const setClauses: string[] = ["updated_at = ?"];
  const values: unknown[] = [new Date().toISOString()];

  if (fields.summary !== undefined) {
    setClauses.push("summary = ?");
    values.push(fields.summary);
  }
  if (fields.confidence !== undefined) {
    setClauses.push("confidence = ?");
    values.push(fields.confidence);
  }
  if (fields.importance !== undefined) {
    setClauses.push("importance = ?");
    values.push(fields.importance);
  }
  if (fields.salience !== undefined) {
    setClauses.push("salience = ?");
    values.push(fields.salience);
  }
  if (fields.keywords !== undefined) {
    setClauses.push("keywords = ?");
    values.push(fields.keywords);
  }
  if (fields.content !== undefined) {
    setClauses.push("content = ?");
    values.push(fields.content);
  }
  if (fields.expire_at !== undefined) {
    setClauses.push("expire_at = ?");
    values.push(fields.expire_at);
  }
  if (fields.activate_at !== undefined) {
    setClauses.push("activate_at = ?");
    values.push(fields.activate_at);
  }
  if (fields.critical !== undefined) {
    setClauses.push("critical = ?");
    values.push(fields.critical);
  }
  if (fields.allow_coexistence !== undefined) {
    setClauses.push("allow_coexistence = ?");
    values.push(fields.allow_coexistence);
  }
  if (fields.attributes !== undefined) {
    setClauses.push("attributes = ?");
    values.push(fields.attributes);
  }
  if (fields.status !== undefined) {
    setClauses.push("status = ?");
    values.push(fields.status);
  }

  if (setClauses.length <= 1) return false;

  values.push(id);
  const result = db
    .prepare(`UPDATE memory_records SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

export function archiveRecord(db: SqliteDatabase, id: string, reason: string): boolean {
  const existing = db.prepare("SELECT attributes FROM memory_records WHERE id = ?").get(id) as
    | { attributes: string }
    | undefined;
  if (!existing) return false;

  let attributes: Record<string, unknown> = {};
  try {
    attributes = JSON.parse(existing.attributes);
  } catch {
    // keep default empty
  }
  attributes._archive_reason = reason;

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE memory_records SET status = 'archived', updated_at = ?, attributes = ? WHERE id = ?`,
  ).run(now, JSON.stringify(attributes), id);
  return true;
}

export function findRecords(db: SqliteDatabase, filters: RecordFindFilters): MemoryRecord[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.status !== undefined) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.type && filters.type.length > 0) {
    const placeholders = filters.type.map(() => "?").join(", ");
    conditions.push(`type IN (${placeholders})`);
    values.push(...filters.type);
  }
  if (filters.importance_min !== undefined) {
    conditions.push("importance >= ?");
    values.push(filters.importance_min);
  }
  if (filters.importance_max !== undefined) {
    conditions.push("importance <= ?");
    values.push(filters.importance_max);
  }
  if (filters.confidence_min !== undefined) {
    conditions.push("confidence >= ?");
    values.push(filters.confidence_min);
  }
  if (filters.confidence_max !== undefined) {
    conditions.push("confidence <= ?");
    values.push(filters.confidence_max);
  }
  if (filters.keywords_contains) {
    conditions.push("keywords LIKE ?");
    values.push(`%${filters.keywords_contains}%`);
  }
  if (filters.text_contains) {
    conditions.push("summary LIKE ?");
    values.push(`%${filters.text_contains}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.max_results ?? 15;

  const rows = db
    .prepare(`SELECT * FROM memory_records ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...values, limit) as unknown[];
  return rows.map(castRow);
}

export function findRecordById(db: SqliteDatabase, id: string): MemoryRecord | null {
  const result = db.prepare("SELECT * FROM memory_records WHERE id = ?").get(id);
  return result ? castRow(result) : null;
}

export function recordExists(db: SqliteDatabase, id: string): boolean {
  const result = db.prepare("SELECT 1 as found FROM memory_records WHERE id = ?").get(id) as
    | { found: number }
    | undefined;
  return result !== undefined;
}

export function findConflictingRecords(
  db: SqliteDatabase,
  type: RecordType,
  keywords: string,
  agentId?: string,
): MemoryRecord[] {
  if (!keywords.trim()) return [];
  const terms = keywords.split(/\s+/).filter(Boolean);
  if (terms.length < 3) return [];

  const conditions = terms.map(() => "keywords LIKE ?");
  const likeValues = terms.map((t) => `%${t}%`);

  let sql = `SELECT * FROM memory_records WHERE type = ? AND status = 'active' AND (${conditions.join(" OR ")})`;
  const params: unknown[] = [type, ...likeValues];

  if (agentId) {
    sql += " AND agent_id = ?";
    params.push(agentId);
  }

  const rows = db.prepare(sql).all(...params) as unknown[];

  const records = rows.map(castRow);

  return records.filter((record) => {
    const recordKeywords = record.keywords.split(/\s+/).filter(Boolean);
    const matched = terms.filter((term) => recordKeywords.some((kw) => kw.includes(term)));
    return matched.length >= 3;
  });
}

export function scanExpiredRecords(db: SqliteDatabase): MemoryRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM memory_records WHERE status = 'active' AND expire_at <= datetime('now')",
    )
    .all() as unknown[];
  return rows.map(castRow);
}

export function scanAllActiveRecords(db: SqliteDatabase): MemoryRecord[] {
  const rows = db
    .prepare("SELECT * FROM memory_records WHERE status = 'active'")
    .all() as unknown[];
  return rows.map(castRow);
}

export function touchAccessTime(db: SqliteDatabase, ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`UPDATE memory_records SET last_accessed_at = ? WHERE id IN (${placeholders})`).run(
    now,
    ...ids,
  );
}
