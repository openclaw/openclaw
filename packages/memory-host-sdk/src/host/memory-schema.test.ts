import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { encodeMemoryEmbedding } from "./embedding-vector.js";
import { ensureMemoryRecallMetadataSchema } from "./memory-schema-recall.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readRows = (db: DatabaseSync, sql: string) => db.prepare(sql).all();
const readRow = (db: DatabaseSync, sql: string) => db.prepare(sql).get();

function sourceSchema({
  id = "id INTEGER PRIMARY KEY",
  idValue = "7",
  path: pathColumn = "path TEXT NOT NULL",
  hash = "hash TEXT NOT NULL",
  unique = "UNIQUE (path, source)",
  extra = "",
  index = "",
}: {
  id?: string;
  idValue?: string;
  path?: string;
  hash?: string;
  unique?: string;
  extra?: string;
  index?: string;
} = {}) {
  return `CREATE TABLE memory_index_sources (
    ${[id, pathColumn, "source TEXT NOT NULL DEFAULT 'memory'", hash, "mtime INTEGER NOT NULL", "size INTEGER NOT NULL", extra, unique].filter(Boolean).join(", ")}
  );
  ${index}
  INSERT INTO memory_index_sources (${id ? "id, " : ""}path, source, hash, mtime, size)
  VALUES (${id ? idValue + ", " : ""}'kept.md', 'memory', 'hash', 1, 2);`;
}

function expectRows(db: DatabaseSync, sql: string, expected: unknown[]) {
  expect(readRows(db, sql)).toEqual(expected);
}
function expectRow(db: DatabaseSync, sql: string, expected: unknown) {
  expect(readRow(db, sql)).toEqual(expected);
}

describe("memory index schema", () => {
  it.each(["fresh", "existing"])(
    "uses the compound chunk index after opening a %s database and readmitting it",
    (kind) => {
      const databasePath = path.join(tempDirs.make("memory-schema-index-"), "memory.sqlite");
      if (kind === "existing") {
        using seed = openNodeSqliteDatabase(databasePath);
        ensureMemoryIndexSchema({ db: seed, cacheEnabled: false, ftsEnabled: false });
        seed.exec(`
          CREATE INDEX IF NOT EXISTS idx_memory_index_chunks_path ON memory_index_chunks(path);
          INSERT INTO memory_index_chunks
            (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES
            ('a', 'shared.md', 'memory', 1, 1, 'a', 'model', 'alpha', X'', 1),
            ('b', 'shared.md', 'sessions', 1, 1, 'b', 'model', 'beta', X'', 1),
            ('c', 'other.md', 'memory', 1, 1, 'c', 'model', 'gamma', X'', 1);
        `);
      }
      using db = new DatabaseSync(databasePath);
      const pathQuery = "SELECT id FROM memory_index_chunks WHERE path = ? ORDER BY id";
      const sourceQuery =
        "SELECT id FROM memory_index_chunks WHERE path = ? AND source = ? ORDER BY id";
      const expectedPath = kind === "existing" ? [{ id: "a" }, { id: "b" }] : [];
      const expectedSource = kind === "existing" ? [{ id: "a" }] : [];
      if (kind === "existing") {
        expect(db.prepare(pathQuery).all("shared.md")).toEqual(expectedPath);
        expect(db.prepare(sourceQuery).all("shared.md", "memory")).toEqual(expectedSource);
      }

      for (let admission = 0; admission < 2; admission++) {
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
        expectRows(
          db,
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name GLOB 'memory_index_*_revision_after_*'",
          [],
        );
        expect(
          readRow(db, "SELECT name FROM sqlite_schema WHERE name = 'idx_memory_index_chunks_path'"),
        ).toBeUndefined();
        expect(db.prepare(pathQuery).all("shared.md")).toEqual(expectedPath);
        expect(db.prepare(sourceQuery).all("shared.md", "memory")).toEqual(expectedSource);
        expect(db.prepare(`EXPLAIN QUERY PLAN ${pathQuery}`).all("shared.md")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              detail: expect.stringContaining("INDEX idx_memory_index_chunks_path_source (path=?)"),
            }),
          ]),
        );
        expect(
          db
            .prepare(
              "EXPLAIN QUERY PLAN DELETE FROM memory_index_chunks WHERE path = ? AND source = ?",
            )
            .all("shared.md", "memory"),
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              detail: expect.stringContaining(
                "INDEX idx_memory_index_chunks_path_source (path=? AND source=?)",
              ),
            }),
          ]),
        );
      }
    },
  );

  it("migrates unreleased inline recall metadata without changing chunk rows", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE memory_index_chunks (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
          model TEXT NOT NULL, text TEXT NOT NULL, embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          importance INTEGER CHECK (importance IS NULL OR importance BETWEEN 1 AND 10),
          triggers TEXT,
          project_key TEXT
        ) STRICT;
        INSERT INTO memory_index_chunks VALUES (
          'legacy', 'MEMORY.md', 'memory', 1, 1, 'h', 'm', 'body', '[]', 7,
          8, 'legacy trigger', 'project/key'
        );
      `);

    ensureMemoryRecallMetadataSchema(db);

    expect(
      readRows(db, "SELECT name FROM pragma_table_info('memory_index_chunks') ORDER BY cid").map(
        (row) => (row as { name: string }).name,
      ),
    ).toEqual([
      "id",
      "path",
      "source",
      "start_line",
      "end_line",
      "hash",
      "model",
      "text",
      "embedding",
      "updated_at",
    ]);
    expectRow(db, "SELECT id, text, updated_at FROM memory_index_chunks", {
      id: "legacy",
      text: "body",
      updated_at: 7,
    });
    expectRow(
      db,
      `SELECT chunk_id AS id, importance, triggers, project_key
             FROM memory_index_chunk_recall_metadata WHERE chunk_id = 'legacy'`,
      {
        id: "legacy",
        importance: 8,
        triggers: "legacy trigger",
        project_key: "project/key",
      },
    );
  });

  it("keeps recall metadata ensure read-only when the schema is current", () => {
    const rootDir = tempDirs.make("openclaw-memory-recall-schema-");
    const databasePath = path.join(rootDir, "memory.sqlite");
    {
      using writable = new DatabaseSync(databasePath);
      ensureMemoryIndexSchema({ db: writable, cacheEnabled: false, ftsEnabled: false });
    }

    using readOnly = new DatabaseSync(databasePath, { readOnly: true });
    expect(() => ensureMemoryRecallMetadataSchema(readOnly)).not.toThrow();
  });

  it("backfills missing provenance and maintains canonical FTS without insert-time provenance", () => {
    using db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    db.exec(`
        INSERT INTO memory_index_meta VALUES ('memory_index_meta_v1', '{"vectorDims":3}');
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('MEMORY.md', 'memory', 'file-hash', 10.75, 20);
      `);
    db.prepare(`
        INSERT INTO memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        ) VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 2, 'chunk-hash', 'embed-model',
          'remember this', ?, 30);
      `).run(encodeMemoryEmbedding([1, 0, 0]));
    db.prepare(`INSERT INTO memory_embedding_cache VALUES (
        'openai', 'embed-model', 'key', 'chunk-hash', ?, 3, 40
      );`).run(encodeMemoryEmbedding([1, 0, 0]));

    const result = ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });

    expect(result.ftsAvailable).toBe(true);
    expectRows(db, "SELECT * FROM memory_index_sources", [
      {
        id: 1,
        path: "MEMORY.md",
        source: "memory",
        hash: "",
        mtime: 10.75,
        size: 20,
      },
    ]);
    expectRows(db, "SELECT id, text FROM memory_index_chunks", [
      { id: "chunk-1", text: "remember this" },
    ]);
    expectRows(db, "SELECT * FROM memory_index_chunk_provenance", [
      {
        chunk_id: "chunk-1",
        origin_class: "untrusted",
        session_kind: "unknown",
        observed_at: 30,
        supersedes_key: null,
      },
    ]);
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    expectRow(db, "SELECT COUNT(*) AS count FROM memory_index_chunk_provenance", {
      count: 1,
    });
    db.prepare(
      `INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "chunk-2",
      "MEMORY.md",
      "memory",
      3,
      3,
      "hash-2",
      "fts-only",
      "next",
      encodeMemoryEmbedding([]),
      50,
    );
    expect(
      db
        .prepare(
          `SELECT origin_class, session_kind, observed_at
             FROM memory_index_chunk_provenance WHERE chunk_id = ?`,
        )
        .get("chunk-2"),
    ).toBeUndefined();
    expect(
      readRow(
        db,
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
      ),
    ).toBeUndefined();
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    expect(
      db
        .prepare(
          `SELECT origin_class, session_kind, observed_at
           FROM memory_index_chunk_provenance WHERE chunk_id = ?`,
        )
        .get("chunk-2"),
    ).toEqual({ origin_class: "untrusted", session_kind: "unknown", observed_at: 50 });
    expectRows(db, "SELECT id, text FROM memory_index_chunks_fts", [
      { id: "chunk-1", text: "remember this" },
      { id: "chunk-2", text: "next" },
    ]);
    expectRows(db, "SELECT provider, hash FROM memory_embedding_cache", [
      { provider: "openai", hash: "chunk-hash" },
    ]);
    expectRows(
      db,
      `SELECT name FROM pragma_table_list
             WHERE schema = 'main'
               AND type = 'table'
               AND name LIKE 'memory_%'
               AND strict <> 1`,
      [],
    );
  });

  it("upgrades canonical tables, preserves mtimes, and invalidates missing provenance", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE memory_index_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE memory_index_sources (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          UNIQUE (path, source)
        );
        CREATE TABLE memory_index_chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          hash TEXT NOT NULL,
          model TEXT NOT NULL,
          text TEXT NOT NULL,
          embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE memory_index_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL
        );
        INSERT INTO memory_index_meta VALUES ('memory_index_meta_v1', '{}');
        INSERT INTO memory_index_sources
          (path, source, hash, mtime, size)
        VALUES ('MEMORY.md', 'memory', 'source-hash', 10.75, 20);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES (
          'chunk-1', 'MEMORY.md', 'memory', 1, 1, 'chunk-hash', 'model', 'body', '[]', 30
        );
        INSERT INTO memory_index_state VALUES (1, 3);
      `);

    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });

    expectRows(
      db,
      `SELECT name FROM pragma_table_list
             WHERE schema = 'main'
               AND type = 'table'
               AND name LIKE 'memory_index_%'
               AND strict <> 1`,
      [],
    );
    expectRow(db, "SELECT mtime, typeof(mtime) AS storage_type FROM memory_index_sources", {
      mtime: 10.75,
      storage_type: "real",
    });
    expectRow(
      db,
      "SELECT type FROM pragma_table_info('memory_index_sources') WHERE name = 'mtime'",
      { type: "REAL" },
    );
    expectRow(db, "SELECT id, text FROM memory_index_chunks", {
      id: "chunk-1",
      text: "body",
    });
    expectRow(db, "SELECT hash FROM memory_index_sources", { hash: "" });
    expectRow(db, "SELECT origin_class FROM memory_index_chunk_provenance", {
      origin_class: "untrusted",
    });
  });

  it("stores separate sources alongside unrelated generic tables", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (name TEXT PRIMARY KEY);
        CREATE TABLE chunks (content TEXT);
        INSERT INTO meta VALUES ('application', 'unrelated');
        INSERT INTO files VALUES ('original');
        INSERT INTO chunks VALUES ('preserved');
      `);
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
    });

    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("shared.md", "memory", "memory-hash", 10, 20);
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("shared.md", "sessions", "session-hash", 30, 40);

    expectRows(db, "SELECT path, source, hash FROM memory_index_sources ORDER BY source", [
      { path: "shared.md", source: "memory", hash: "memory-hash" },
      { path: "shared.md", source: "sessions", hash: "session-hash" },
    ]);
    expectRows(db, "SELECT * FROM meta", [{ key: "application", value: "unrelated" }]);
    expectRows(db, "SELECT * FROM files", [{ name: "original" }]);
    expectRows(db, "SELECT * FROM chunks", [{ content: "preserved" }]);
  });

  it("backfills and maintains one path FTS row per source without changing body FTS", () => {
    using db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    db.exec(`
        INSERT INTO memory_index_sources
          (path, source, hash, mtime, size)
        VALUES ('shared-notes.md', 'memory', 'source-hash', 1, 2);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          ('chunk-a', 'shared-notes.md', 'memory', 1, 1, 'a', 'model', 'alpha body', X'', 1),
          ('chunk-b', 'shared-notes.md', 'memory', 2, 2, 'b', 'model', 'beta body', X'', 1);
      `);

    const result = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });

    expect(result.ftsAvailable).toBe(true);
    expectRows(db, "SELECT id, text FROM memory_index_chunks_fts ORDER BY id", [
      { id: "chunk-a", text: "alpha body" },
      { id: "chunk-b", text: "beta body" },
    ]);
    expectRows(db, "SELECT path, source FROM memory_index_paths_fts ORDER BY source, path", [
      { path: "shared-notes.md", source: "memory" },
    ]);
    expect(
      readRow(
        db,
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memory_index_paths_fts_after_delete'",
      ),
    ).toMatchObject({
      sql: expect.stringContaining("WHERE rowid = OLD.id"),
    });
    expect(
      db
        .prepare("EXPLAIN QUERY PLAN DELETE FROM memory_index_paths_fts WHERE rowid = ?")
        .all(1)
        .map((row) => (row as { detail: string }).detail)
        .join("\n"),
    ).toMatch(/VIRTUAL TABLE INDEX 0:=/);
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    expectRow(db, "SELECT COUNT(*) AS count FROM memory_index_paths_fts", {
      count: 1,
    });
    expect(
      db
        .prepare("SELECT path FROM memory_index_paths_fts WHERE memory_index_paths_fts MATCH ?")
        .all('"shared"'),
    ).toEqual([{ path: "shared-notes.md" }]);

    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("shared-notes.md", "sessions", "session-hash", 3, 4);
    expectRows(db, "SELECT path, source FROM memory_index_paths_fts ORDER BY source", [
      { path: "shared-notes.md", source: "memory" },
      { path: "shared-notes.md", source: "sessions" },
    ]);

    db.prepare(
      "UPDATE memory_index_sources SET id = id + 100, path = ?, source = ? WHERE path = ? AND source = ?",
    ).run("renamed-notes.md", "memory", "shared-notes.md", "sessions");
    expectRows(db, "SELECT path, source FROM memory_index_paths_fts ORDER BY path", [
      { path: "renamed-notes.md", source: "memory" },
      { path: "shared-notes.md", source: "memory" },
    ]);
    expectRows(db, "SELECT rowid, path FROM memory_index_paths_fts ORDER BY path", [
      { rowid: 102, path: "renamed-notes.md" },
      { rowid: 1, path: "shared-notes.md" },
    ]);

    db.prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?").run(
      "renamed-notes.md",
      "memory",
    );
    expectRows(db, "SELECT path, source FROM memory_index_paths_fts", [
      { path: "shared-notes.md", source: "memory" },
    ]);
  });

  it("keeps source and path FTS identities stable across VACUUM", () => {
    const rootDir = tempDirs.make("openclaw-memory-vacuum-");
    using db = new DatabaseSync(path.join(rootDir, "memory.sqlite"));
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    db.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES
          ('memory/alpha.md', 'memory', 'alpha', 1, 1),
          ('memory/beta.md', 'memory', 'beta', 1, 1);
      `);
    const sourceRowsBefore = readRows(
      db,
      "SELECT id, path FROM memory_index_sources ORDER BY path",
    );
    const pathRowsBefore = readRows(
      db,
      "SELECT rowid, path FROM memory_index_paths_fts ORDER BY path",
    );

    db.exec("VACUUM");
    expectRows(db, "SELECT id, path FROM memory_index_sources ORDER BY path", sourceRowsBefore);
    expectRows(db, "SELECT rowid, path FROM memory_index_paths_fts ORDER BY path", pathRowsBefore);

    db.prepare("UPDATE memory_index_sources SET path = ? WHERE path = ? AND source = ?").run(
      "memory/alpha-renamed.md",
      "memory/alpha.md",
      "memory",
    );
    db.prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?").run(
      "memory/beta.md",
      "memory",
    );

    expectRows(db, "SELECT path, source FROM memory_index_paths_fts", [
      { path: "memory/alpha-renamed.md", source: "memory" },
    ]);
  });

  it("keeps a large stale-source delete batch aligned with path FTS", () => {
    using db = new DatabaseSync(":memory:");
    const result = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    if (!result.ftsAvailable) {
      return;
    }
    const insert = db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', ?, 0, 0)",
    );
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 10_000; index += 1) {
      const key = index.toString().padStart(5, "0");
      insert.run(`memory/${key}.md`, key);
    }
    db.exec("COMMIT");

    const deleteSource = db.prepare(
      "DELETE FROM memory_index_sources WHERE path = ? AND source = 'memory'",
    );
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 1_000; index += 1) {
      deleteSource.run(`memory/${index.toString().padStart(5, "0")}.md`);
    }
    db.exec("COMMIT");

    expectRow(db, "SELECT COUNT(*) AS count FROM memory_index_sources", {
      count: 9_000,
    });
    expectRow(db, "SELECT COUNT(*) AS count FROM memory_index_paths_fts", {
      count: 9_000,
    });
    expectRow(
      db,
      `SELECT COUNT(*) AS count
             FROM memory_index_sources AS sources
             LEFT JOIN memory_index_paths_fts AS paths ON paths.rowid = sources.id
             WHERE paths.rowid IS NULL OR paths.path != sources.path OR paths.source != sources.source`,
      { count: 0 },
    );
  });

  it("honors shipped custom cache and FTS table names", () => {
    using db = new DatabaseSync(":memory:");
    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      cacheEnabled: true,
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });

    expect(result.ftsAvailable).toBe(true);
    expectRows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('embedding_cache', 'chunks_fts', 'memory_embedding_cache', 'memory_index_chunks_fts') ORDER BY name",
      [{ name: "chunks_fts" }, { name: "embedding_cache" }],
    );
  });

  it("upgrades path-keyed source tables to stable identities", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE memory_index_sources (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        INSERT INTO memory_index_sources VALUES ('shared.md', 'memory', 'memory-hash', 10.75, 20);
      `);

    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
    });

    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("shared.md", "sessions", "session-hash", 30, 40);

    expectRows(
      db,
      "SELECT id, path, source, hash, mtime FROM memory_index_sources ORDER BY source",
      [
        { id: 1, path: "shared.md", source: "memory", hash: "memory-hash", mtime: 10.75 },
        { id: 2, path: "shared.md", source: "sessions", hash: "session-hash", mtime: 30 },
      ],
    );
    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
    expectRows(db, "SELECT id FROM memory_index_sources ORDER BY id", [{ id: 1 }, { id: 2 }]);
  });

  it("migrates composite source keys and rebuilds path FTS rowids", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE memory_index_sources (
          path TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          PRIMARY KEY (path, source)
        );
        INSERT INTO memory_index_sources (rowid, path, source, hash, mtime, size)
        VALUES
          (41, 'shared.md', 'memory', 'memory-hash', 10, 20),
          (84, 'shared.md', 'sessions', 'session-hash', 30, 40);
        CREATE VIRTUAL TABLE memory_index_paths_fts USING fts5(path, source UNINDEXED);
        INSERT INTO memory_index_paths_fts (path, source)
        VALUES ('shared.md', 'memory'), ('shared.md', 'sessions');
        CREATE TRIGGER memory_index_paths_fts_after_delete
        AFTER DELETE ON memory_index_sources
        BEGIN
          DELETE FROM memory_index_paths_fts
          WHERE path = OLD.path AND source = OLD.source;
        END;
      `);

    const result = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    if (!result.ftsAvailable) {
      throw new Error(result.ftsError ?? "FTS unavailable");
    }

    expectRows(db, "SELECT id, path, source FROM memory_index_sources ORDER BY id", [
      { id: 41, path: "shared.md", source: "memory" },
      { id: 84, path: "shared.md", source: "sessions" },
    ]);
    expectRows(db, "SELECT rowid, path, source FROM memory_index_paths_fts ORDER BY rowid", [
      { rowid: 41, path: "shared.md", source: "memory" },
      { rowid: 84, path: "shared.md", source: "sessions" },
    ]);
    expect(() =>
      db
        .prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("shared.md", "memory", "duplicate", 1, 1),
    ).toThrow();

    ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
    expectRows(db, "SELECT id FROM memory_index_sources ORDER BY id", [{ id: 41 }, { id: 84 }]);
  });

  it.each([
    ["an unkeyed legacy table", sourceSchema({ id: "", unique: "" })],
    [
      "a non-integer primary key",
      sourceSchema({ id: "id TEXT PRIMARY KEY", idValue: "'source-1'" }),
    ],
    ["a descending integer primary key", sourceSchema({ id: "id INTEGER PRIMARY KEY DESC" })],
    [
      "partial path and source uniqueness",
      sourceSchema({
        unique: "",
        index:
          "CREATE UNIQUE INDEX memory_index_sources_partial_unique ON memory_index_sources(path, source) WHERE source = 'memory';",
      }),
    ],
    [
      "expression-extended path and source uniqueness",
      sourceSchema({
        unique: "",
        index:
          "CREATE UNIQUE INDEX memory_index_sources_expression_unique ON memory_index_sources(path, source, lower(hash));",
      }),
    ],
    [
      "case-folded path uniqueness",
      sourceSchema({ unique: "UNIQUE (path COLLATE NOCASE, source)" }),
    ],
    [
      "a hidden generated column",
      sourceSchema({ extra: "normalized_hash TEXT GENERATED ALWAYS AS (lower(hash)) VIRTUAL" }),
    ],
    ["an unexpected column default", sourceSchema({ hash: "hash TEXT NOT NULL DEFAULT ''" })],
    [
      "a case-folded path column",
      sourceSchema({
        path: "path TEXT COLLATE NOCASE NOT NULL",
        unique: "UNIQUE (path COLLATE BINARY, source COLLATE BINARY)",
      }),
    ],
    [
      "an extra unique content constraint",
      sourceSchema({ unique: "UNIQUE (path, source), UNIQUE (hash)" }),
    ],
  ])("rejects %s instead of claiming canonical source identity", (_name, schemaSql) => {
    using db = new DatabaseSync(":memory:");
    db.exec(schemaSql);

    expect(() => ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toThrow(
      "canonical memory source identity schema is invalid",
    );
    expectRows(db, "SELECT path, hash FROM memory_index_sources", [
      { path: "kept.md", hash: "hash" },
    ]);
  });

  it("rolls back a failed source-identity migration", () => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
        CREATE TABLE memory_index_sources (
          path TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL,
          PRIMARY KEY (path, source)
        );
        INSERT INTO memory_index_sources VALUES ('kept.md', 'memory', 'hash', 1, 2);
        CREATE TABLE memory_index_chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          hash TEXT NOT NULL,
          model TEXT NOT NULL,
          text TEXT NOT NULL,
          embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO memory_index_chunks VALUES (
          'sentinel', 'kept.md', 'memory', 1, 1, 'chunk-hash', 'model', 'body', '[]', 1
        );
        CREATE TABLE memory_index_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL
        );
        INSERT INTO memory_index_state VALUES (1, 7);
        CREATE TRIGGER memory_index_sources_revision_after_insert
        AFTER INSERT ON memory_index_sources
        BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
        CREATE TRIGGER memory_index_sources_revision_after_update
        AFTER UPDATE ON memory_index_sources
        BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
        CREATE TRIGGER memory_index_sources_revision_after_delete
        AFTER DELETE ON memory_index_sources
        BEGIN UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1; END;
        CREATE TABLE memory_index_paths_fts (wrong_column TEXT);
        INSERT INTO memory_index_paths_fts VALUES ('keep-derived-row');
        CREATE TRIGGER memory_index_paths_fts_after_delete
        AFTER DELETE ON memory_index_sources BEGIN SELECT 1; END;
      `);

    expect(() => ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toThrow();
    expectRows(db, "SELECT path, source, hash FROM memory_index_sources", [
      { path: "kept.md", source: "memory", hash: "hash" },
    ]);
    expectRows(db, "SELECT wrong_column FROM memory_index_paths_fts", [
      { wrong_column: "keep-derived-row" },
    ]);
    expectRows(db, "SELECT id, text FROM memory_index_chunks", [{ id: "sentinel", text: "body" }]);
    expectRows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_index_sources_revision_after_%' ORDER BY name",
      [
        { name: "memory_index_sources_revision_after_delete" },
        { name: "memory_index_sources_revision_after_insert" },
        { name: "memory_index_sources_revision_after_update" },
      ],
    );
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("temporary.md", "memory", "temporary", 1, 1);
    db.prepare("UPDATE memory_index_sources SET hash = ? WHERE path = ?").run(
      "updated",
      "temporary.md",
    );
    db.prepare("DELETE FROM memory_index_sources WHERE path = ?").run("temporary.md");
    expectRow(db, "SELECT revision FROM memory_index_state WHERE id = 1", {
      revision: 10,
    });
    expectRow(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'memory_index_paths_fts_after_delete'",
      { name: "memory_index_paths_fts_after_delete" },
    );
  });
});
