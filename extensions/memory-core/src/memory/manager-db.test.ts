// Memory Core tests cover shared agent database publication and shadow cleanup.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAgedMemoryReindexTempFiles,
  publishMemoryDatabaseTables,
  readMemoryDatabaseRevision,
  removeMemoryDatabaseFiles,
} from "./manager-db.js";
import { acquireMemoryReindexLock } from "./manager-reindex-lock.js";

function ensureTestMemorySchema(db: DatabaseSync, cacheEnabled = true): void {
  ensureMemoryIndexSchema({
    db,
    cacheEnabled,
    ftsEnabled: false,
  });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toThrow("ENOENT");
}

describe("memory manager database publication", () => {
  let fixtureRoot = "";

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-db-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
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

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
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

  it("loads sqlite-vec on the target before publishing a shadow vector table", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath, { allowExtension: true });
    const sourceDb = new DatabaseSync(sourcePath, { allowExtension: true });
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
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

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
        vectorExtensionPath: sourceVector.extensionPath,
      });

      expect(targetDb.prepare("SELECT id FROM memory_index_chunks_vec").all()).toEqual([
        { id: "vector" },
      ]);
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("rejects a stale shadow publish after a concurrent live memory update", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    let concurrentDb: DatabaseSync | undefined;
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      targetDb
        .prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("memory.md", "memory", "published", 1, 1);
      sourceDb
        .prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("memory.md", "memory", "shadow", 1, 1);
      const expectedRevision = readMemoryDatabaseRevision(targetDb);
      sourceDb.close();

      concurrentDb = new DatabaseSync(targetPath);
      concurrentDb
        .prepare("UPDATE memory_index_sources SET hash = ? WHERE path = ? AND source = ?")
        .run("newer", "memory.md", "memory");
      concurrentDb.close();
      concurrentDb = undefined;

      await expect(
        publishMemoryDatabaseTables({
          targetDb,
          sourcePath,
          metaKey: "memory_index_meta",
          expectedRevision,
        }),
      ).rejects.toThrow(/changed while full reindex was building/);
      expect(
        targetDb
          .prepare("SELECT hash FROM memory_index_sources WHERE path = ? AND source = ?")
          .get("memory.md", "memory"),
      ).toEqual({ hash: "newer" });
    } finally {
      try {
        concurrentDb?.close();
      } catch {}
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("preserves the live embedding cache when the shadow index has caching disabled", async () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb, false);
      targetDb
        .prepare(
          `INSERT INTO memory_embedding_cache (
             provider, model, provider_key, hash, embedding, dims, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("test", "model", "key", "hash", "[]", 0, 1);
      sourceDb.close();

      await publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
      });

      expect(targetDb.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([
        { hash: "hash" },
      ]);
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("removes aged orphan shadows but preserves young and locked shadows", async () => {
    const databasePath = path.join(fixtureRoot, "agent.sqlite");
    const database = new DatabaseSync(databasePath);
    database.close();
    const oldShadow = `${databasePath}.memory-reindex-11111111-2222-3333-4444-555555555555`;
    const youngShadow = `${databasePath}.memory-reindex-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    const lockedShadow = `${databasePath}.memory-reindex-99999999-aaaa-bbbb-cccc-dddddddddddd`;
    const old = new Date(Date.now() - 48 * 60 * 60_000);

    for (const suffix of ["", "-wal", "-journal"]) {
      await fs.writeFile(`${oldShadow}${suffix}`, "orphan");
      await fs.utimes(`${oldShadow}${suffix}`, old, old);
    }
    await fs.writeFile(youngShadow, "active");
    await fs.writeFile(lockedShadow, "locked");
    await fs.utimes(lockedShadow, old, old);

    const lock = acquireMemoryReindexLock(databasePath);
    cleanupAgedMemoryReindexTempFiles(databasePath);
    await expect(fs.access(lockedShadow)).resolves.toBeUndefined();
    lock.release();

    cleanupAgedMemoryReindexTempFiles(databasePath);

    await expectPathMissing(oldShadow);
    await expectPathMissing(`${oldShadow}-wal`);
    await expectPathMissing(`${oldShadow}-journal`);
    await expectPathMissing(lockedShadow);
    await expect(fs.access(youngShadow)).resolves.toBeUndefined();
  });

  it("continues removing shadow sidecars after one cleanup failure", () => {
    const databasePath = path.join(fixtureRoot, "agent.sqlite.memory-reindex-shadow");
    const removedPaths: string[] = [];
    const lockedError = Object.assign(new Error("EBUSY: resource busy or locked"), {
      code: "EBUSY",
    });
    vi.spyOn(fsSync, "rmSync").mockImplementation((filePath) => {
      const resolvedPath = String(filePath);
      removedPaths.push(resolvedPath);
      if (resolvedPath.endsWith("-wal")) {
        throw lockedError;
      }
    });

    expect(() => removeMemoryDatabaseFiles(databasePath)).toThrow("EBUSY");
    expect(removedPaths).toEqual([
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ]);
  });
});
