// Memory Core tests cover shared agent database publication and shadow cleanup.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupAgedMemoryReindexTempFiles,
  publishMemoryDatabaseTables,
  readMemoryDatabaseRevision,
} from "./manager-db.js";
import { acquireMemoryReindexLock } from "./manager-reindex-lock.js";

function ensureTestMemorySchema(db: DatabaseSync): void {
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    cacheEnabled: true,
    ftsTable: "chunks_fts",
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
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("removes a stale vector table when the shadow index has no vectors", () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      targetDb.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
      targetDb.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)").run("stale", "[]");
      sourceDb.close();

      publishMemoryDatabaseTables({
        targetDb,
        sourcePath,
        metaKey: "memory_index_meta",
        expectedRevision: readMemoryDatabaseRevision(targetDb),
      });

      expect(
        targetDb
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'")
          .get(),
      ).toBeUndefined();
    } finally {
      try {
        sourceDb.close();
      } catch {}
      targetDb.close();
    }
  });

  it("rejects a stale shadow publish after a concurrent live memory update", () => {
    const targetPath = path.join(fixtureRoot, "target.sqlite");
    const sourcePath = path.join(fixtureRoot, "source.sqlite");
    const targetDb = new DatabaseSync(targetPath);
    const sourceDb = new DatabaseSync(sourcePath);
    let concurrentDb: DatabaseSync | undefined;
    try {
      ensureTestMemorySchema(targetDb);
      ensureTestMemorySchema(sourceDb);
      targetDb
        .prepare("INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)")
        .run("memory.md", "memory", "published", 1, 1);
      sourceDb
        .prepare("INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)")
        .run("memory.md", "memory", "shadow", 1, 1);
      const expectedRevision = readMemoryDatabaseRevision(targetDb);
      sourceDb.close();

      concurrentDb = new DatabaseSync(targetPath);
      concurrentDb.prepare("UPDATE files SET hash = ? WHERE path = ?").run("newer", "memory.md");
      concurrentDb.close();
      concurrentDb = undefined;

      expect(() =>
        publishMemoryDatabaseTables({
          targetDb,
          sourcePath,
          metaKey: "memory_index_meta",
          expectedRevision,
        }),
      ).toThrow(/changed while full reindex was building/);
      expect(
        targetDb.prepare("SELECT hash FROM files WHERE path = ?").get("memory.md"),
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
});
