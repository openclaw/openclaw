// Memory schema tests cover canonical table creation and shipped-name migration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../../../src/infra/node-sqlite.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { encodeMemoryEmbedding } from "./embedding-vector.js";
import { ensureMemoryRecallMetadataSchema } from "./memory-schema-recall.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("memory index schema", () => {
  it.each(["existing"])(
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
        expect(
          db
            .prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_memory_index_chunks_path'")
            .get(),
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
    const db = new DatabaseSync(":memory:");
    try {
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
        db
          .prepare("SELECT name FROM pragma_table_info('memory_index_chunks') ORDER BY cid")
          .all()
          .map((row) => (row as { name: string }).name),
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
      expect(db.prepare("SELECT id, text, updated_at FROM memory_index_chunks").get()).toEqual({
        id: "legacy",
        text: "body",
        updated_at: 7,
      });
      expect(
        db
          .prepare(
            `SELECT chunk_id AS id, importance, triggers, project_key
             FROM memory_index_chunk_recall_metadata WHERE chunk_id = 'legacy'`,
          )
          .get(),
      ).toEqual({
        id: "legacy",
        importance: 8,
        triggers: "legacy trigger",
        project_key: "project/key",
      });
    } finally {
      db.close();
    }
  });

  it("keeps recall metadata ensure read-only when the schema is current", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-recall-schema-"));
    const databasePath = path.join(rootDir, "memory.sqlite");
    const writable = new DatabaseSync(databasePath);
    try {
      ensureMemoryIndexSchema({ db: writable, cacheEnabled: false, ftsEnabled: false });
    } finally {
      writable.close();
    }

    const readOnly = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(() => ensureMemoryRecallMetadataSchema(readOnly)).not.toThrow();
    } finally {
      readOnly.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("backfills missing provenance and maintains canonical FTS without insert-time provenance", () => {
    const db = new DatabaseSync(":memory:");
    try {
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
      expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([
        {
          id: 1,
          path: "MEMORY.md",
          source: "memory",
          hash: "",
          mtime: 10.75,
          size: 20,
        },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
        { id: "chunk-1", text: "remember this" },
      ]);
      expect(db.prepare("SELECT * FROM memory_index_chunk_provenance").all()).toEqual([
        {
          chunk_id: "chunk-1",
          origin_class: "untrusted",
          session_kind: "unknown",
          observed_at: 30,
          supersedes_key: null,
        },
      ]);
      ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunk_provenance").get(),
      ).toEqual({
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
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'memory_index_chunk_provenance_after_insert'",
          )
          .get(),
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
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts").all()).toEqual([
        { id: "chunk-1", text: "remember this" },
        { id: "chunk-2", text: "next" },
      ]);
      expect(db.prepare("SELECT provider, hash FROM memory_embedding_cache").all()).toEqual([
        { provider: "openai", hash: "chunk-hash" },
      ]);
      expect(
        db
          .prepare(
            `SELECT name FROM pragma_table_list
             WHERE schema = 'main'
               AND type = 'table'
               AND name LIKE 'memory_%'
               AND strict <> 1`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("stores separate sources alongside unrelated generic tables", () => {
    const db = new DatabaseSync(":memory:");
    try {
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

      expect(
        db.prepare("SELECT path, source, hash FROM memory_index_sources ORDER BY source").all(),
      ).toEqual([
        { path: "shared.md", source: "memory", hash: "memory-hash" },
        { path: "shared.md", source: "sessions", hash: "session-hash" },
      ]);
      expect(db.prepare("SELECT * FROM meta").all()).toEqual([
        { key: "application", value: "unrelated" },
      ]);
      expect(db.prepare("SELECT * FROM files").all()).toEqual([{ name: "original" }]);
      expect(db.prepare("SELECT * FROM chunks").all()).toEqual([{ content: "preserved" }]);
    } finally {
      db.close();
    }
  });

  it("honors shipped custom cache and FTS table names", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const result = ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        cacheEnabled: true,
        ftsTable: "chunks_fts",
        ftsEnabled: true,
      });

      expect(result.ftsAvailable).toBe(true);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('embedding_cache', 'chunks_fts', 'memory_embedding_cache', 'memory_index_chunks_fts') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "chunks_fts" }, { name: "embedding_cache" }]);
    } finally {
      db.close();
    }
  });

  it("upgrades path-keyed source tables to stable identities", () => {
    const db = new DatabaseSync(":memory:");
    try {
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

      expect(
        db
          .prepare("SELECT id, path, source, hash, mtime FROM memory_index_sources ORDER BY source")
          .all(),
      ).toEqual([
        { id: 1, path: "shared.md", source: "memory", hash: "memory-hash", mtime: 10.75 },
        { id: 2, path: "shared.md", source: "sessions", hash: "session-hash", mtime: 30 },
      ]);
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      expect(db.prepare("SELECT id FROM memory_index_sources ORDER BY id").all()).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it("migrates composite source keys and rebuilds path FTS rowids", () => {
    const db = new DatabaseSync(":memory:");
    try {
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

      expect(
        db.prepare("SELECT id, path, source FROM memory_index_sources ORDER BY id").all(),
      ).toEqual([
        { id: 41, path: "shared.md", source: "memory" },
        { id: 84, path: "shared.md", source: "sessions" },
      ]);
      expect(
        db.prepare("SELECT rowid, path, source FROM memory_index_paths_fts ORDER BY rowid").all(),
      ).toEqual([
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
      expect(db.prepare("SELECT id FROM memory_index_sources ORDER BY id").all()).toEqual([
        { id: 41 },
        { id: 84 },
      ]);
    } finally {
      db.close();
    }
  });

  it.each([
    [
      "an unkeyed legacy table",
      `CREATE TABLE memory_index_sources (
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      INSERT INTO memory_index_sources VALUES ('kept.md', 'memory', 'hash', 1, 2);`,
    ],
    [
      "a descending integer primary key",
      `CREATE TABLE memory_index_sources (
        id INTEGER PRIMARY KEY DESC,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (path, source)
      );
      INSERT INTO memory_index_sources VALUES (7, 'kept.md', 'memory', 'hash', 1, 2);`,
    ],
    [
      "partial path and source uniqueness",
      `CREATE TABLE memory_index_sources (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX memory_index_sources_partial_unique
        ON memory_index_sources(path, source) WHERE source = 'memory';
      INSERT INTO memory_index_sources VALUES (7, 'kept.md', 'memory', 'hash', 1, 2);`,
    ],
    [
      "a hidden generated column",
      `CREATE TABLE memory_index_sources (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        normalized_hash TEXT GENERATED ALWAYS AS (lower(hash)) VIRTUAL,
        UNIQUE (path, source)
      );
      INSERT INTO memory_index_sources (id, path, source, hash, mtime, size)
      VALUES (7, 'kept.md', 'memory', 'hash', 1, 2);`,
    ],
    [
      "an extra unique content constraint",
      `CREATE TABLE memory_index_sources (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        UNIQUE (path, source),
        UNIQUE (hash)
      );
      INSERT INTO memory_index_sources VALUES (7, 'kept.md', 'memory', 'hash', 1, 2);`,
    ],
  ])("rejects %s instead of claiming canonical source identity", (_name, schemaSql) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(schemaSql);

      expect(() => ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false })).toThrow(
        "canonical memory source identity schema is invalid",
      );
      expect(db.prepare("SELECT path, hash FROM memory_index_sources").all()).toEqual([
        { path: "kept.md", hash: "hash" },
      ]);
    } finally {
      db.close();
    }
  });

  it("rolls back a failed source-identity migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
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

      expect(() =>
        ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false }),
      ).toThrow();
      expect(db.prepare("SELECT path, source, hash FROM memory_index_sources").all()).toEqual([
        { path: "kept.md", source: "memory", hash: "hash" },
      ]);
      expect(db.prepare("SELECT wrong_column FROM memory_index_paths_fts").all()).toEqual([
        { wrong_column: "keep-derived-row" },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
        { id: "sentinel", text: "body" },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memory_index_sources_revision_after_%' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "memory_index_sources_revision_after_delete" },
        { name: "memory_index_sources_revision_after_insert" },
        { name: "memory_index_sources_revision_after_update" },
      ]);
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
      ).run("temporary.md", "memory", "temporary", 1, 1);
      db.prepare("UPDATE memory_index_sources SET hash = ? WHERE path = ?").run(
        "updated",
        "temporary.md",
      );
      db.prepare("DELETE FROM memory_index_sources WHERE path = ?").run("temporary.md");
      expect(db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual({
        revision: 10,
      });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'memory_index_paths_fts_after_delete'",
          )
          .get(),
      ).toEqual({ name: "memory_index_paths_fts_after_delete" });
    } finally {
      db.close();
    }
  });
});
