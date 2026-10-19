import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  ensureMemoryChunkProvenance,
  MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL,
} from "./memory-schema-provenance.js";

function fixture(
  sourceDefinition: string,
  options: { withoutRowid?: boolean; chunkCollation?: "BINARY" | "NOCASE" } = {},
) {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  db.exec(`
    CREATE TABLE memory_index_sources (${sourceDefinition})${options.withoutRowid ? " WITHOUT ROWID" : ""};
    CREATE TABLE memory_index_chunks (
      id TEXT PRIMARY KEY, path TEXT COLLATE ${options.chunkCollation ?? "BINARY"}, source TEXT, updated_at INTEGER
    );
    CREATE TABLE memory_index_state (id INTEGER PRIMARY KEY, revision INTEGER);
    INSERT INTO memory_index_state VALUES (1, 0);
    INSERT INTO memory_index_sources(path, source, hash) VALUES
      ('notes.md', 'memory', 'stale'), ('notes.md', 'sessions', 'untouched');
    INSERT INTO memory_index_chunks VALUES
      ('owned', 'notes.md', 'memory', 10),
      ('missing-1', 'notes.md', 'memory', 11),
      ('missing-2', 'notes.md', 'memory', 12);
  `);
  return db;
}

describe("memory chunk provenance backfill", () => {
  it.each([
    ["WITHOUT ROWID sources", "path TEXT, source TEXT, hash TEXT, PRIMARY KEY(path, source)", true],
    ["shadowed rowid", "rowid INTEGER DEFAULT 7, path TEXT, source TEXT, hash TEXT", false],
  ] as const)(
    "preserves source matching and existing provenance with %s",
    (_name, columns, withoutRowid) => {
      const db = fixture(columns, { withoutRowid });
      db.exec(MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL);
      db.exec(`CREATE TRIGGER memory_index_chunk_provenance_after_insert
        AFTER INSERT ON memory_index_chunks BEGIN SELECT 1; END`);
      db.exec(`INSERT INTO memory_index_chunk_provenance VALUES
      ('owned', 'owner', 'interactive', 3, 'prior')`);
      ensureMemoryChunkProvenance(db);
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT source, hash FROM memory_index_sources ORDER BY source").all(),
      ).toEqual([
        { source: "memory", hash: "" },
        { source: "sessions", hash: "untouched" },
      ]);
      expect(db.prepare("SELECT revision FROM memory_index_state").get()).toEqual({ revision: 1 });
      expect(
        db.prepare("SELECT * FROM memory_index_chunk_provenance ORDER BY chunk_id").all(),
      ).toEqual([
        {
          chunk_id: "missing-1",
          origin_class: "untrusted",
          session_kind: "unknown",
          observed_at: 11,
          supersedes_key: null,
        },
        {
          chunk_id: "missing-2",
          origin_class: "untrusted",
          session_kind: "unknown",
          observed_at: 12,
          supersedes_key: null,
        },
        {
          chunk_id: "owned",
          origin_class: "owner",
          session_kind: "interactive",
          observed_at: 3,
          supersedes_key: "prior",
        },
      ]);
      ensureMemoryChunkProvenance(db);
      expect(db.prepare("SELECT revision FROM memory_index_state").get()).toEqual({ revision: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    },
  );

  it("keeps NULL source matching and chunk-side path collation", () => {
    const db = fixture("path TEXT COLLATE BINARY, source TEXT, hash TEXT", {
      chunkCollation: "NOCASE",
    });
    db.exec(`
      INSERT INTO memory_index_sources VALUES ('UPPER.md', NULL, 'null-source');
      INSERT INTO memory_index_chunks VALUES ('nullable', 'upper.md', NULL, 20);
    `);
    ensureMemoryChunkProvenance(db);
    expect(db.prepare("SELECT hash FROM memory_index_sources WHERE source IS NULL").get()).toEqual({
      hash: "",
    });
    expect(db.prepare("SELECT revision FROM memory_index_state").get()).toEqual({ revision: 1 });
    expect(
      db
        .prepare(
          "SELECT observed_at FROM memory_index_chunk_provenance WHERE chunk_id = 'nullable'",
        )
        .get(),
    ).toEqual({ observed_at: 20 });
  });

  it.each([false, true])(
    "rolls back source invalidation and provenance when revision publication fails (caller transaction %s)",
    (outer) => {
      const db = fixture("path TEXT, source TEXT, hash TEXT");
      db.exec(`CREATE TRIGGER refuse_revision BEFORE UPDATE ON memory_index_state
      BEGIN SELECT RAISE(ABORT, 'revision refused'); END`);
      if (outer) {
        db.exec("BEGIN IMMEDIATE");
      }
      expect(() => ensureMemoryChunkProvenance(db)).toThrow("revision refused");
      expect(db.isTransaction).toBe(outer);
      if (outer) {
        db.exec("ROLLBACK");
      }
      expect(db.prepare("SELECT revision FROM memory_index_state").get()).toEqual({ revision: 0 });
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE source = 'memory'").get(),
      ).toEqual({ hash: "stale" });
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_index_chunk_provenance'")
          .get(),
      ).toBeUndefined();
    },
  );
});
