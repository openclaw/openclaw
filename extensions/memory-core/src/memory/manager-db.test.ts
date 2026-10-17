import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import {
  publishMemoryDatabaseTables,
  readMemoryDatabaseRevision,
  MemoryIndexRevisionConflictError,
} from "./manager-db-kernel.js";
import {
  cleanupAgedMemoryReindexTempFiles,
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
  resetMemoryDatabase,
} from "./manager-db.js";
import { bindSqliteWorkerBackend } from "./manager-publication.worker.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";

async function publish(params: Parameters<typeof publishMemoryDatabaseTables>[0]): Promise<void> {
  publishMemoryDatabaseTables(params);
}

describe("memory manager database publication", () => {
  let fixtureRoot = "";
  function database(name: string, ftsEnabled = false, allowExtension = false) {
    const db = new DatabaseSync(path.join(fixtureRoot, name), { allowExtension });
    try {
      ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled });
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  const rows = (db: DatabaseSync, query: string) => db.prepare(query).all();
  const insertSource = (db: DatabaseSync, file: string, hash: string, id?: number, stamp = 1) =>
    db
      .prepare(`INSERT INTO memory_index_sources (id, path, source, hash, mtime, size)
      VALUES (?, ?, 'memory', ?, ?, ?)`)
      .run(id ?? null, file, hash, stamp, stamp);

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
  });
  afterAll(() => resetMemoryCoreDreamingStateForTests());

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-db-"));
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("sets busy_timeout on memory sqlite connections", () => {
    const db = openMemoryDatabaseAtPath(path.join(fixtureRoot, "index.sqlite"), false);
    try {
      const row = db.prepare("PRAGMA busy_timeout").get() as
        | { busy_timeout?: number; timeout?: number }
        | undefined;
      expect(row?.busy_timeout ?? row?.timeout).toBe(5000);
    } finally {
      closeMemoryDatabase(db);
    }
  });

  it("resets only derived memory tables, preserves their schema, and is repeatable", async () => {
    const dbPath = path.join(fixtureRoot, "index.sqlite");
    using db = database("index.sqlite", true, true);
    const vector = await loadSqliteVecExtension({ db });
    expect(vector.ok).toBe(true);
    db.exec(`
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3]);
        CREATE TABLE memory_unrelated (payload BLOB);
        INSERT INTO memory_unrelated VALUES (x'00ff80');
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('MEMORY.md', 'memory', 'old', 1, 1);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES ('chunk', 'MEMORY.md', 'memory', 1, 1, 'old', 'model', 'old text', x'', 1);
        INSERT INTO memory_index_chunks_vec VALUES ('chunk', '[0,1,0]');
        INSERT INTO memory_index_chunk_recall_metadata VALUES ('chunk', 9, 'old trigger', NULL);
        INSERT INTO memory_index_chunk_provenance VALUES ('chunk', 'owner', 'interactive', 1, NULL);
        INSERT INTO memory_index_meta VALUES ('meta', 'old');
      `);
    const embedding = encodeMemoryEmbedding([0, 1, 0]);
    db.prepare("UPDATE memory_index_chunks SET embedding = ? WHERE id = 'chunk'").run(embedding);
    db.prepare(
      "INSERT INTO memory_embedding_cache VALUES ('test', 'model', 'key', 'old', ?, 3, 1)",
    ).run(embedding);
    const schema = () => rows(db, "SELECT type, name, sql FROM sqlite_schema ORDER BY name");
    const beforeSchema = schema();
    const revision = readMemoryDatabaseRevision(db);
    await resetMemoryDatabase({ targetDb: db, dbPath, workspaceDir: fixtureRoot });
    expect(schema()).toEqual(beforeSchema);
    expect(rows(db, "SELECT hex(payload) AS bytes FROM memory_unrelated")).toEqual([
      { bytes: "00FF80" },
    ]);
    for (const table of [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_paths_fts",
      "memory_index_chunks_vec",
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_embedding_cache",
      "memory_index_meta",
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({
        count: 0,
      });
    }
    const resetRevision = readMemoryDatabaseRevision(db);
    expect(resetRevision).toBe(revision + 1);
    expect(await resetMemoryDatabase({ targetDb: db, dbPath, workspaceDir: fixtureRoot })).toBe(
      false,
    );
    expect(readMemoryDatabaseRevision(db)).toBe(resetRevision);
  });

  it("does not create an index when there is nothing to reset", async () => {
    const dbPath = path.join(fixtureRoot, "index.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('retained')");
      expect(await resetMemoryDatabase({ targetDb: db, dbPath, workspaceDir: fixtureRoot })).toBe(
        false,
      );
      expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([{ name: "unrelated" }]);
      expect(db.prepare("SELECT * FROM unrelated").all()).toEqual([{ value: "retained" }]);
    } finally {
      db.close();
    }
  });

  it("lazily adds recall metadata storage before publishing to an existing database", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      targetDb.exec(`
        CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE memory_index_sources (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
          hash TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL, UNIQUE (path, source)
        ) STRICT;
        CREATE TABLE memory_index_chunks (
          chunk_rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
          path TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'memory',
          start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL,
          model TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE memory_index_state (
          id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
        ) STRICT;
        INSERT INTO memory_index_state (id, revision) VALUES (1, 0);
      `);
      ensureTestMemorySchema(sourceDb, false);
      sourceDb
        .prepare(
          `INSERT INTO memory_index_chunks
           (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "new",
          "MEMORY.md",
          "memory",
          1,
          1,
          "hash",
          "model",
          "body",
          encodeMemoryEmbedding([]),
          1,
        );
      sourceDb
        .prepare(
          `INSERT INTO memory_index_chunk_recall_metadata
           (chunk_id, importance, triggers) VALUES (?, ?, ?)`,
        )
        .run("new", 9, "when flying");
      sourceDb.close();

      await publishPreparedMemoryDatabase({
        targetDb,
        sourcePath,
        sourceHasVectors: false,
        metaKey: "meta",
        expectedRevision: 0,
      });

      expect(
        targetDb
          .prepare("SELECT importance, triggers FROM memory_index_chunk_recall_metadata")
          .get(),
      ).toEqual({ importance: 9, triggers: "when flying" });
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("removes a stale vector table when the shadow index has no vectors", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      targetDb.exec("CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
      targetDb
        .prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)")
        .run("stale", "[]");
      sourceDb.close();

      await publishPreparedMemoryDatabase({
        targetDb,
        sourcePath,
        sourceHasVectors: false,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
      });

      expect(
        targetDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_index_chunks_vec'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("publishes stable path and chunk identities and restores FTS maintenance", async () => {
    using targetDb = database("target.sqlite", true);
    using sourceDb = database("source.sqlite", true);
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const query = (sql: string, ...values: SQLInputValue[]) => targetDb.prepare(sql).all(...values);
    const select = (table: string, fields: string) =>
      query(`SELECT ${fields} FROM memory_index_${table}`);
    const replacementPath = "memory/replacement.md";
    insertSource(targetDb, "memory/stale.md", "stale");
    const embedding = encodeMemoryEmbedding([0.1234567890123456, -0.5]);
    const insertChunk = (db: DatabaseSync, rowid: number, id: string, text: string) => {
      db.prepare(
        `INSERT INTO memory_index_chunks
             (chunk_rowid, id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, 'memory', 1, 1, ?, 'model', ?, ?, 1)`,
      ).run(rowid, id, `memory/${id}.md`, id, text, embedding);
      db.prepare(`INSERT INTO memory_index_chunk_provenance
          (chunk_id, origin_class, session_kind, observed_at)
          VALUES (?, 'owner', 'interactive', 1)`).run(id);
    };
    insertChunk(targetDb, 7, "stale", "Old violetmarker");
    for (const [fts, table, label] of [
      ["paths", "sources", "path"],
      ["chunks", "chunks", "body"],
    ]) {
      targetDb.exec(`
        DROP TRIGGER memory_index_${fts}_fts_after_delete;
        CREATE TRIGGER memory_index_${fts}_fts_after_delete AFTER DELETE ON memory_index_${table}
        BEGIN SELECT RAISE(ABORT, '${label} FTS trigger fired during bulk publish'); END;
      `);
    }
    insertSource(sourceDb, replacementPath, "replacement", 42, 2);
    insertChunk(sourceDb, 84, "replacement", "New ambermarker");
    const expectedRevision = readMemoryDatabaseRevision(targetDb);
    sourceDb.close();

    await publish({ targetDb, sourcePath, metaKey: "meta", expectedRevision });

    expect(select("paths_fts", "path, source")).toEqual([
      { path: replacementPath, source: "memory" },
    ]);
    expect(select("sources", "id, path")).toEqual([{ id: 42, path: replacementPath }]);
    expect(select("paths_fts", "rowid, path")).toEqual([{ rowid: 42, path: replacementPath }]);
    expect(select("chunks", "chunk_rowid, id, embedding")).toEqual([
      { chunk_rowid: 84, id: "replacement", embedding },
    ]);
    expect(select("chunks_fts", "rowid, id")).toEqual([{ rowid: 84, id: "replacement" }]);
    const bodyMatches = (text: string) =>
      query(
        "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? ORDER BY id",
        text,
      );
    expect(bodyMatches("ambermarker")).toEqual([{ id: "replacement" }]);
    expect(bodyMatches("violetmarker")).toEqual([]);
    expect(
      query(
        "SELECT path FROM memory_index_paths_fts WHERE memory_index_paths_fts MATCH ?",
        '"replacement"',
      ),
    ).toEqual([{ path: replacementPath }]);
    insertSource(targetDb, "memory/after-publish.md", "after", undefined, 3);
    insertChunk(targetDb, 85, "after-publish", "Fresh ambermarker");
    expect(bodyMatches("ambermarker")).toEqual([{ id: "after-publish" }, { id: "replacement" }]);
    targetDb
      .prepare("UPDATE memory_index_chunks SET text = ? WHERE id = ?")
      .run("Updated saffronmarker", "after-publish");
    targetDb.prepare("DELETE FROM memory_index_chunks WHERE id = ?").run("replacement");
    expect(bodyMatches("ambermarker")).toEqual([]);
    expect(bodyMatches("saffronmarker")).toEqual([{ id: "after-publish" }]);
    expect(
      query("SELECT path FROM memory_index_paths_fts ORDER BY path").map(
        (row) => (row as { path: string }).path,
      ),
    ).toEqual(["memory/after-publish.md", replacementPath]);
    targetDb
      .prepare("UPDATE memory_index_sources SET path = ? WHERE path = ? AND source = ?")
      .run("memory/after-update.md", "memory/after-publish.md", "memory");
    targetDb
      .prepare("DELETE FROM memory_index_sources WHERE path = ? AND source = ?")
      .run(replacementPath, "memory");
    expect(query("SELECT path FROM memory_index_paths_fts")).toEqual([
      { path: "memory/after-update.md" },
    ]);
  });

  it("removes FTS tables and triggers when the shadow has FTS disabled", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb, true, true);
      ensureTestMemorySchema(sourceDb);
      const expectedRevision = readMemoryDatabaseRevision(targetDb);
      sourceDb.close();

      await publishPreparedMemoryDatabase({
        targetDb,
        sourcePath,
        sourceHasVectors: false,
        metaKey: "meta",
        expectedRevision,
      });

      expect(
        targetDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('memory_index_paths_fts', 'memory_index_chunks_fts')",
          )
          .all(),
      ).toEqual([]);
      expect(
        targetDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'memory_index_paths_fts_after_%' OR name LIKE 'memory_index_chunks_fts_after_%')",
          )
          .all(),
      ).toEqual([]);
      expect(() =>
        targetDb
          .prepare(
            "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
          )
          .run("memory/after-disabled-publish.md", "memory", "after", 1, 1),
      ).not.toThrow();
      expect(() =>
        targetDb.exec(`INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES ('after', 'memory/after-disabled-publish.md', 'memory', 1, 1, 'after', 'fts-only', 'after', x'', 1)`),
      ).not.toThrow();
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("publishes a prepared shadow vector table", async () => {
    using targetDb = database("target.sqlite", false, true);
    using sourceDb = database("source.sqlite", false, true);
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const sourceVector = await loadSqliteVecExtension({ db: sourceDb });
    if (!sourceVector.ok) {
      return;
    }
    sourceDb.exec(`
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[3]
        )
      `);
    sourceDb
      .prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)")
      .run("vector", JSON.stringify([0, 1, 0]));
    sourceDb.close();

    const targetVector = await loadSqliteVecExtension({
      db: targetDb,
      extensionPath: sourceVector.extensionPath,
    });
    expect(targetVector.ok).toBe(true);
    await publish({
      targetDb,
      sourcePath,
      metaKey: "memory_index_meta",
      expectedRevision: readMemoryDatabaseRevision(targetDb),
    });

    expect(rows(targetDb, "SELECT id FROM memory_index_chunks_vec")).toEqual([{ id: "vector" }]);
  });

  it("rejects a stale shadow publish after a concurrent live memory update", async () => {
    using targetDb = database("target.sqlite");
    using sourceDb = database("source.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    for (const [db, hash] of [
      [targetDb, "published"],
      [sourceDb, "shadow"],
    ] as const) {
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
      ).run("memory.md", "sessions", hash, 1, 1);
    }
    const expectedRevision = readMemoryDatabaseRevision(targetDb);
    sourceDb.close();

    using concurrentDb = new DatabaseSync(path.join(fixtureRoot, "target.sqlite"));
    const publisher = bindSqliteWorkerBackend(
      { kind: "agent" },
      {
        databasePath: path.join(fixtureRoot, "target.sqlite"),
        database: concurrentDb,
        admit: () => undefined,
      },
    );
    try {
      expect(
        publisher.execute({
          type: "source.refresh",
          input: {
            path: "memory.md",
            expectedHash: "published",
            hash: "newer",
            mtime: 2,
            size: 2,
          },
        }),
      ).toMatchObject({ ok: true, value: true });
    } finally {
      publisher.close();
    }
    concurrentDb.close();

    const publication = publish({
      targetDb,
      sourcePath,
      metaKey: "memory_index_meta",
      expectedRevision,
    });
    await expect(publication).rejects.toBeInstanceOf(MemoryIndexRevisionConflictError);
    await expect(publication).rejects.toThrow(/changed while full reindex was building/);
    expect(
      targetDb
        .prepare("SELECT hash FROM memory_index_sources WHERE path = ? AND source = ?")
        .get("memory.md", "sessions"),
    ).toEqual({ hash: "newer" });
  });

  it("preserves the live embedding cache instead of publishing the shadow cache", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      targetDb
        .prepare(
          `INSERT INTO memory_embedding_cache (
             provider, model, provider_key, hash, embedding, dims, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("test", "model", "key", "live-hash", encodeMemoryEmbedding([]), 0, 1);
      sourceDb
        .prepare(
          `INSERT INTO memory_embedding_cache (
             provider, model, provider_key, hash, embedding, dims, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("test", "model", "key", "shadow-hash", encodeMemoryEmbedding([1]), 1, 2);
      sourceDb.close();

      await publishPreparedMemoryDatabase({
        targetDb,
        sourcePath,
        sourceHasVectors: false,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
      });

      expect(targetDb.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([
        { hash: "live-hash" },
      ]);
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("removes aged orphan shadows under the maintenance lease but preserves young shadows", async () => {
    const databasePath = path.join(fixtureRoot, "agent.sqlite");
    new DatabaseSync(databasePath).close();
    const oldShadow = `${databasePath}.memory-reindex-11111111-2222-3333-4444-555555555555`;
    const youngShadow = `${databasePath}.memory-reindex-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const old = new Date(Date.now() - 48 * 60 * 60_000);

    for (const suffix of ["", "-wal", "-journal"]) {
      await fs.writeFile(`${oldShadow}${suffix}`, "orphan");
      await fs.utimes(`${oldShadow}${suffix}`, old, old);
    }
    await fs.writeFile(youngShadow, "active");

    const lock = await waitForMemoryReindexLock(databasePath);
    try {
      await cleanupAgedMemoryReindexTempFiles(databasePath);
    } finally {
      await lock.release();
    }

    for (const suffix of ["", "-wal", "-journal"]) {
      await expect(fs.access(`${oldShadow}${suffix}`)).rejects.toThrow("ENOENT");
    }
    await fs.access(youngShadow);
  });
});
