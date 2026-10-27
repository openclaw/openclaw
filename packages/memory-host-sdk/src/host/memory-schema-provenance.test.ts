import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
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
  const expectRows = (sql: string, expected: unknown[]) =>
    expect(db.prepare(sql).all()).toEqual(expected);
  return { db, expectRows };
}

it.each([
  ["WITHOUT ROWID sources", "path TEXT, source TEXT, hash TEXT, PRIMARY KEY(path, source)", true],
  ["shadowed rowid", "rowid INTEGER DEFAULT 7, path TEXT, source TEXT, hash TEXT", false],
] as const)(
  "preserves source matching and existing provenance with %s",
  (_name, columns, withoutRowid) => {
    const { db, expectRows } = fixture(columns, { withoutRowid });
    db.exec(MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL);
    db.exec(`INSERT INTO memory_index_chunk_provenance VALUES
      ('owned', 'owner', 'interactive', 3, 'prior')`);
    ensureMemoryChunkProvenance(db);
    expectRows("SELECT source, hash FROM memory_index_sources ORDER BY source", [
      { source: "memory", hash: "" },
      { source: "sessions", hash: "untouched" },
    ]);
    expectRows("SELECT revision FROM memory_index_state", [{ revision: 1 }]);
    expect(
      db
        .prepare(`SELECT chunk_id, origin_class, session_kind, observed_at, supersedes_key
        FROM memory_index_chunk_provenance ORDER BY chunk_id`)
        .all()
        .map(Object.values),
    ).toEqual([
      ["missing-1", "untrusted", "unknown", 11, null],
      ["missing-2", "untrusted", "unknown", 12, null],
      ["owned", "owner", "interactive", 3, "prior"],
    ]);
    ensureMemoryChunkProvenance(db);
    expectRows("SELECT revision FROM memory_index_state", [{ revision: 1 }]);
  },
);

it("keeps NULL source matching and chunk-side path collation", () => {
  const { db, expectRows } = fixture("path TEXT COLLATE BINARY, source TEXT, hash TEXT", {
    chunkCollation: "NOCASE",
  });
  db.exec(`
      INSERT INTO memory_index_sources VALUES ('UPPER.md', NULL, 'null-source');
      INSERT INTO memory_index_chunks VALUES ('nullable', 'upper.md', NULL, 20);
    `);
  ensureMemoryChunkProvenance(db);
  expectRows("SELECT hash FROM memory_index_sources WHERE source IS NULL", [{ hash: "" }]);
  expectRows("SELECT revision FROM memory_index_state", [{ revision: 1 }]);
  expectRows("SELECT observed_at FROM memory_index_chunk_provenance WHERE chunk_id = 'nullable'", [
    { observed_at: 20 },
  ]);
});

it.each([false, true])(
  "rolls back source invalidation and provenance when revision publication fails (caller transaction %s)",
  (outer) => {
    const { db, expectRows } = fixture("path TEXT, source TEXT, hash TEXT");
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
    expectRows("SELECT revision FROM memory_index_state", [{ revision: 0 }]);
    expectRows("SELECT hash FROM memory_index_sources WHERE source = 'memory'", [
      { hash: "stale" },
    ]);
    expectRows("SELECT name FROM sqlite_schema WHERE name = 'memory_index_chunk_provenance'", []);
  },
);
