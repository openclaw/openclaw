// Memory schema tests cover canonical table creation and shipped-name migration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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

  it("does not import a legacy sidecar memory database during schema startup", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-sidecar-"));
    const legacyPath = path.join(rootDir, "memory", "main.sqlite");
    const agentPath = path.join(rootDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    const legacyDb = new DatabaseSync(legacyPath);
    try {
      legacyDb.exec(`
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
        INSERT INTO meta VALUES ('memory_index_meta_v1', '{"vectorDims":3}');
        INSERT INTO files VALUES ('MEMORY.md', 'memory', 'file-hash', 10, 20);
        INSERT INTO chunks VALUES (
          'chunk-1', 'MEMORY.md', 'memory', 1, 2, 'chunk-hash', 'embed-model',
          'remember this', '[1,0,0]', 30
        );
        INSERT INTO embedding_cache VALUES (
          'openai', 'embed-model', 'key', 'chunk-hash', '[1,0,0]', 3, 40
        );
      `);
    } finally {
      legacyDb.close();
    }

    const db = new DatabaseSync(agentPath);
    try {
      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: true,
        ftsEnabled: true,
      });

      expect(result.ftsAvailable).toBe(true);
      expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks").all()).toEqual([]);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts").all()).toEqual([]);
      expect(db.prepare("SELECT provider, hash FROM memory_embedding_cache").all()).toEqual([]);
      expect(fs.existsSync(legacyPath)).toBe(true);
    } finally {
      db.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
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

  it("backfills and maintains one path FTS row per source without changing body FTS", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
      db.exec(`
        INSERT INTO memory_index_sources
          (path, source, hash, mtime, size)
        VALUES ('shared-notes.md', 'memory', 'source-hash', 1, 2);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES
          ('chunk-a', 'shared-notes.md', 'memory', 1, 1, 'a', 'model', 'alpha body', '[]', 1),
          ('chunk-b', 'shared-notes.md', 'memory', 2, 2, 'b', 'model', 'beta body', '[]', 1);
      `);

      const result = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });

      expect(result.ftsAvailable).toBe(true);
      expect(db.prepare("SELECT id, text FROM memory_index_chunks_fts ORDER BY id").all()).toEqual([
        { id: "chunk-a", text: "alpha body" },
        { id: "chunk-b", text: "beta body" },
      ]);
      expect(
        db.prepare("SELECT path, source FROM memory_index_paths_fts ORDER BY source, path").all(),
      ).toEqual([{ path: "shared-notes.md", source: "memory" }]);
      expect(
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'memory_index_paths_fts_after_delete'",
          )
          .get(),
      ).toMatchObject({
        sql: expect.stringContaining("WHERE path = OLD.path AND source = OLD.source"),
      });
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_paths_fts").get()).toEqual({
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
      expect(
        db.prepare("SELECT path, source FROM memory_index_paths_fts ORDER BY source").all(),
      ).toEqual([
        { path: "shared-notes.md", source: "memory" },
        { path: "shared-notes.md", source: "sessions" },
      ]);

      db.prepare(
        "UPDATE memory_index_sources SET path = ?, source = ? WHERE path = ? AND source = ?",
      ).run("renamed-notes.md", "memory", "shared-notes.md", "sessions");
      expect(
        db.prepare("SELECT path, source FROM memory_index_paths_fts ORDER BY path").all(),
      ).toEqual([
        { path: "renamed-notes.md", source: "memory" },
        { path: "shared-notes.md", source: "memory" },
      ]);

      db.prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?").run(
        "renamed-notes.md",
        "memory",
      );
      expect(db.prepare("SELECT path, source FROM memory_index_paths_fts").all()).toEqual([
        { path: "shared-notes.md", source: "memory" },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps path FTS cleanup correct after source rowids are remapped", () => {
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      db.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES
          ('memory/alpha.md', 'memory', 'alpha', 1, 1),
          ('memory/beta.md', 'memory', 'beta', 1, 1);
      `);
      const pathRowsBefore = db
        .prepare("SELECT rowid, path FROM memory_index_paths_fts ORDER BY path")
        .all();

      // Deterministically model VACUUM's documented freedom to rewrite an
      // implicit rowid without changing the canonical source identity.
      db.exec("UPDATE memory_index_sources SET rowid = rowid + 100");
      expect(
        db.prepare("SELECT rowid, path FROM memory_index_paths_fts ORDER BY path").all(),
      ).toEqual(pathRowsBefore);

      db.prepare("UPDATE memory_index_sources SET path = ? WHERE path = ? AND source = ?").run(
        "memory/alpha-renamed.md",
        "memory/alpha.md",
        "memory",
      );
      db.prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?").run(
        "memory/beta.md",
        "memory",
      );

      expect(db.prepare("SELECT path, source FROM memory_index_paths_fts").all()).toEqual([
        { path: "memory/alpha-renamed.md", source: "memory" },
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
});
