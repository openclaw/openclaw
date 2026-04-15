import type { DatabaseSync } from "node:sqlite";

export const SIDECAR_SCHEMA_VERSION = 1;

// Backend-agnostic v2 lifecycle sidecar. Keyed by memoryRefId(ref) so the same
// row applies whether the underlying chunk is served by the builtin SQLite
// backend or by the qmd subprocess. Schema is intentionally additive: it is
// never read or written from any hot path in this slice.
export function ensureSidecarSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_v2_records (
      ref_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      memory_type TEXT,
      importance REAL,
      salience REAL,
      confidence REAL,
      status TEXT NOT NULL DEFAULT 'active',
      pinned INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT,
      source_ref TEXT,
      superseded_by TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_accessed_at INTEGER,
      consolidated_at INTEGER,
      location_id TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1
    );
  `);
  ensureColumn(db, "memory_v2_records", "location_id", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_v2_records_path ON memory_v2_records(path);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_v2_records_status ON memory_v2_records(status);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_memory_v2_records_location ON memory_v2_records(location_id);`,
  );
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('memory_v2_schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SIDECAR_SCHEMA_VERSION));
}

// Mirrors src/memory-host-sdk/host/memory-schema.ts:96 — additive ALTER for
// dbs that pre-date a column being part of the canonical CREATE TABLE.
function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function readSidecarSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'memory_v2_schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    return null;
  }
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) ? n : null;
}
