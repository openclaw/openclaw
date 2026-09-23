import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ensureMemoryChunkProvenance,
  MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL,
} from "./memory-schema-provenance.js";

function fixture(
  sourceDefinition: string,
  options: { withoutRowid?: boolean; chunkCollation?: "BINARY" | "NOCASE" } = {},
) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE memory_index_sources (${sourceDefinition})${options.withoutRowid ? " WITHOUT ROWID" : ""};
    CREATE TABLE memory_index_chunks (
      id TEXT PRIMARY KEY, path TEXT COLLATE ${options.chunkCollation ?? "BINARY"}, source TEXT, updated_at INTEGER
    );
    CREATE TABLE revision (value INTEGER);
    INSERT INTO revision VALUES (0);
    CREATE TRIGGER source_revision AFTER UPDATE ON memory_index_sources
    BEGIN UPDATE revision SET value = value + 1; END;
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
    ["no source id", "path TEXT, source TEXT, hash TEXT", false],
    ["WITHOUT ROWID sources", "path TEXT, source TEXT, hash TEXT, PRIMARY KEY(path, source)", true],
    ["shadowed rowid", "rowid INTEGER DEFAULT 7, path TEXT, source TEXT, hash TEXT", false],
  ] as const)(
    "preserves source matching and existing provenance with %s",
    (_name, columns, withoutRowid) => {
      const db = fixture(columns, { withoutRowid });
      try {
        db.exec(MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL);
        db.exec(`INSERT INTO memory_index_chunk_provenance VALUES
        ('owned', 'owner', 'interactive', 3, 'prior')`);
        ensureMemoryChunkProvenance(db);
        expect(
          db.prepare("SELECT source, hash FROM memory_index_sources ORDER BY source").all(),
        ).toEqual([
          { source: "memory", hash: "" },
          { source: "sessions", hash: "untouched" },
        ]);
        expect(db.prepare("SELECT value FROM revision").get()).toEqual({ value: 1 });
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
        expect(db.prepare("SELECT value FROM revision").get()).toEqual({ value: 1 });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  it("keeps NULL source matching and chunk-side path collation", () => {
    const db = fixture("path TEXT COLLATE BINARY, source TEXT, hash TEXT", {
      chunkCollation: "NOCASE",
    });
    try {
      db.exec(`
        INSERT INTO memory_index_sources VALUES ('UPPER.md', NULL, 'null-source');
        INSERT INTO memory_index_chunks VALUES ('nullable', 'upper.md', NULL, 20);
      `);
      ensureMemoryChunkProvenance(db);
      expect(
        db.prepare("SELECT hash FROM memory_index_sources WHERE source IS NULL").get(),
      ).toEqual({ hash: "" });
      expect(db.prepare("SELECT value FROM revision").get()).toEqual({ value: 2 });
      expect(
        db
          .prepare(
            "SELECT observed_at FROM memory_index_chunk_provenance WHERE chunk_id = 'nullable'",
          )
          .get(),
      ).toEqual({ observed_at: 20 });
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "preserves invalidation failure and rollback with caller transaction %s",
    (outer) => {
      const db = fixture("path TEXT, source TEXT, hash TEXT");
      try {
        db.exec(`CREATE TRIGGER refuse_invalidation BEFORE UPDATE ON memory_index_sources
        BEGIN SELECT RAISE(ABORT, 'invalidation refused'); END`);
        if (outer) {
          db.exec("BEGIN IMMEDIATE");
        }
        expect(() => ensureMemoryChunkProvenance(db)).toThrow("invalidation refused");
        expect(db.isTransaction).toBe(outer);
        if (outer) {
          db.exec("ROLLBACK");
        }
        expect(db.prepare("SELECT value FROM revision").get()).toEqual({ value: 0 });
        expect(
          db
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'memory_index_chunk_provenance'")
            .get(),
        ).toBeUndefined();
      } finally {
        db.close();
      }
    },
  );
});
