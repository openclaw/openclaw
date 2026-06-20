// Memory schema tests cover canonical table creation and shipped-name migration.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";

describe("memory index schema", () => {
  it("migrates shipped generic tables into canonical memory tables", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        CREATE TABLE embedding_cache (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          provider_key TEXT NOT NULL,
          hash TEXT NOT NULL,
          embedding TEXT NOT NULL,
          dims INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider, model, provider_key, hash)
        );
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED,
          start_line UNINDEXED, end_line UNINDEXED
        );
        INSERT INTO meta VALUES ('memory_index_meta_v1', '{"vectorDims":3}');
        INSERT INTO files VALUES ('MEMORY.md', 'memory', 'file-hash', 10, 20);
        INSERT INTO chunks VALUES (
          'chunk-1', 'MEMORY.md', 'memory', 1, 2, 'chunk-hash', 'embed-model',
          'remember this', '[1,0,0]', 30
        );
        INSERT INTO embedding_cache VALUES (
          'openai', 'embed-model', 'key', 'chunk-hash', '[1,0,0]', 3, 40
        );
        INSERT INTO chunks_fts VALUES (
          'remember this', 'chunk-1', 'MEMORY.md', 'memory', 'embed-model', 1, 2
        );
      `);

      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: true,
        ftsEnabled: true,
      });

      expect(result.ftsAvailable).toBe(true);
      expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([
        { path: "MEMORY.md", source: "memory", hash: "file-hash", mtime: 10, size: 20 },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([
        { id: "chunk-1", text: "remember this" },
      ]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts").all()).toEqual([
        { id: "chunk-1", text: "remember this" },
      ]);
      expect(db.prepare("SELECT provider, hash FROM memory_embedding_cache").all()).toEqual([
        { provider: "openai", hash: "chunk-hash" },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks', 'embedding_cache', 'chunks_fts')",
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("stores source records with the same path in separate sources", () => {
    const db = new DatabaseSync(":memory:");
    try {
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

  it("upgrades canonical source tables keyed only by path", () => {
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
        INSERT INTO memory_index_sources VALUES ('shared.md', 'memory', 'memory-hash', 10, 20);
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
        db.prepare("SELECT path, source, hash FROM memory_index_sources ORDER BY source").all(),
      ).toEqual([
        { path: "shared.md", source: "memory", hash: "memory-hash" },
        { path: "shared.md", source: "sessions", hash: "session-hash" },
      ]);
    } finally {
      db.close();
    }
  });

  it("leaves unrelated generic tables untouched", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, owner TEXT);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          source TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          hash TEXT NOT NULL,
          model TEXT NOT NULL,
          text TEXT NOT NULL,
          embedding TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: false,
      });

      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'files', 'chunks') ORDER BY name",
          )
          .all(),
      ).toEqual([{ name: "chunks" }, { name: "files" }, { name: "meta" }]);
    } finally {
      db.close();
    }
  });

  it("keeps legacy tables when canonical rows conflict", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE files (
          path TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER NOT NULL
        );
        CREATE TABLE chunks (
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
        CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO meta VALUES ('memory_index_meta_v1', 'legacy');
        INSERT INTO memory_index_meta VALUES ('memory_index_meta_v1', 'canonical');
      `);

      expect(() =>
        ensureMemoryIndexSchema({
          db,
          cacheEnabled: false,
          ftsEnabled: false,
        }),
      ).toThrow("legacy memory meta rows conflict");
      expect(db.prepare("SELECT value FROM meta").get()).toEqual({ value: "legacy" });
      expect(db.prepare("SELECT value FROM memory_index_meta").get()).toEqual({
        value: "canonical",
      });
    } finally {
      db.close();
    }
  });

  it("skips FTS virtual-table drift scans after the repair marker is current", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });
      db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "chunk-1",
        "memory/2026-06-17-1649.md",
        "memory",
        1,
        2,
        "hash",
        "mock",
        "note",
        "[0]",
        1,
      );
      db.prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("note", "chunk-1", "memory/2026-06-17-1649.md", "memory", "mock", 1, 2);
      db.prepare(
        "INSERT INTO memory_index_chunks_fts_path (path_text, text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "memory/2026-06-17-1649.md",
        "note",
        "chunk-1",
        "memory/2026-06-17-1649.md",
        "memory",
        "mock",
        1,
        2,
      );

      const prepareSpy = vi.spyOn(db, "prepare");
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });

      const preparedSql = prepareSpy.mock.calls.map(([sql]) => sql).join("\n");
      expect(preparedSql).not.toContain("WHERE NOT EXISTS");
      expect(preparedSql).not.toContain("memory_index_chunks_fts AS f");
      expect(preparedSql).not.toContain("memory_index_chunks_fts_path AS f");
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });

  it("rebuilds unmarked body FTS rows when same-count text drifts from canonical chunks", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });
      db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "body-strong-long-path",
        "memory/segment0/segment1/body-source.md",
        "memory",
        1,
        3,
        "strong-hash",
        "mock-embed",
        "alpha alpha alpha alpha",
        "[0]",
        1,
      );
      db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "body-weak-short-path",
        "memory/a.md",
        "memory",
        1,
        1,
        "weak-hash",
        "mock-embed",
        "alpha",
        "[0]",
        1,
      );
      db.prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "memory/segment0/segment1/body-source.md\nalpha alpha alpha alpha",
        "body-strong-long-path",
        "memory/segment0/segment1/body-source.md",
        "memory",
        "mock-embed",
        1,
        3,
      );
      db.prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "memory/a.md\nalpha",
        "body-weak-short-path",
        "memory/a.md",
        "memory",
        "mock-embed",
        1,
        1,
      );
      db.prepare(
        "INSERT INTO memory_index_chunks_fts_path (path_text, text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "memory/segment0/segment1/body-source.md",
        "alpha alpha alpha alpha",
        "body-strong-long-path",
        "memory/segment0/segment1/body-source.md",
        "memory",
        "mock-embed",
        1,
        3,
      );
      db.prepare(
        "INSERT INTO memory_index_chunks_fts_path (path_text, text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "memory/a.md",
        "alpha",
        "body-weak-short-path",
        "memory/a.md",
        "memory",
        "mock-embed",
        1,
        1,
      );
      db.prepare("DELETE FROM memory_index_meta WHERE key = ?").run("memory_index_fts_repair_v2");

      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });

      expect(
        db
          .prepare("SELECT text FROM memory_index_chunks_fts WHERE id = ?")
          .get("body-strong-long-path"),
      ).toEqual({ text: "alpha alpha alpha alpha" });
    } finally {
      db.close();
    }
  });

  it("preserves unmarked FTS rows when repair fails", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });
      db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "chunk-1",
        "memory/2026-06-17-1649.md",
        "memory",
        1,
        2,
        "hash",
        "mock",
        "canonical body",
        "[0]",
        1,
      );
      db.prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("previous body", "chunk-1", "memory/2026-06-17-1649.md", "memory", "mock", 1, 2);
      db.prepare(
        "INSERT INTO memory_index_chunks_fts_path (path_text, text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "previous/path.md",
        "previous body",
        "chunk-1",
        "memory/2026-06-17-1649.md",
        "memory",
        "mock",
        1,
        2,
      );
      db.prepare("DELETE FROM memory_index_meta WHERE key = ?").run("memory_index_fts_repair_v2");

      const originalExec = db.exec.bind(db);
      const originalPrepare = db.prepare.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO memory_index_chunks_fts_path")) {
          throw new Error("forced path repair failure");
        }
        return originalExec(sql);
      });
      vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
        if (sql.includes("INSERT INTO memory_index_chunks_fts_path")) {
          throw new Error("forced path repair failure");
        }
        return originalPrepare(sql);
      });

      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });

      expect(result).toMatchObject({
        ftsAvailable: false,
        ftsError: "forced path repair failure",
      });
      expect(
        db.prepare("SELECT text FROM memory_index_chunks_fts WHERE id = ?").get("chunk-1"),
      ).toEqual({ text: "previous body" });
      expect(
        db
          .prepare("SELECT path_text FROM memory_index_chunks_fts_path WHERE id = ?")
          .get("chunk-1"),
      ).toEqual({ path_text: "previous/path.md" });
    } finally {
      vi.restoreAllMocks();
      db.close();
    }
  });
});
