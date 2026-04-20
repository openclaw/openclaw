import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SIDECAR_SCHEMA_VERSION,
  ensureSidecarSchema,
  readSidecarSchemaVersion,
} from "./sidecar-schema.js";

describe("sidecar schema", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates the records table and meta on a fresh db", () => {
    ensureSidecarSchema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("memory_v2_records");
    expect(names).toContain("meta");
  });

  it("includes the location_id column and its index", () => {
    ensureSidecarSchema(db);
    const cols = (
      db.prepare(`PRAGMA table_info(memory_v2_records)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("location_id");
    const indexes = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_v2_records'`,
        )
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_memory_v2_records_location");
  });

  it("backfills the location_id column on a pre-existing table without it", () => {
    db.exec(`
      CREATE TABLE memory_v2_records (
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
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `);
    ensureSidecarSchema(db);
    const cols = (
      db.prepare(`PRAGMA table_info(memory_v2_records)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("location_id");
  });

  it("writes the current schema_version", () => {
    ensureSidecarSchema(db);
    expect(readSidecarSchemaVersion(db)).toBe(SIDECAR_SCHEMA_VERSION);
  });

  it("is idempotent across repeated calls", () => {
    ensureSidecarSchema(db);
    ensureSidecarSchema(db);
    ensureSidecarSchema(db);
    expect(readSidecarSchemaVersion(db)).toBe(SIDECAR_SCHEMA_VERSION);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM meta WHERE key = 'memory_v2_schema_version'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("does not create an FTS virtual table (Phase 1 has no retrieval surface)", () => {
    ensureSidecarSchema(db);
    const fts = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'`)
      .all();
    expect(fts).toEqual([]);
  });

  it("returns null version on an uninitialized db", () => {
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    expect(readSidecarSchemaVersion(db)).toBeNull();
  });
});
