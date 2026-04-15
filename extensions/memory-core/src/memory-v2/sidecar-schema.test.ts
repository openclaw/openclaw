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
