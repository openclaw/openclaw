import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanupAgedMemoryReindexTempFiles,
  closeMemoryDatabase,
  openMemoryDatabaseAtPath,
  openMemoryReindexTempDatabaseAtPath,
} from "./manager-db.js";
import {
  acquireMemoryReindexSwapLock,
  acquireMemoryReindexLock,
  resolveMemoryReindexLockPath,
  tryAcquireMemoryReindexSwapLock,
  tryAcquireMemoryReindexLock,
} from "./manager-reindex-lock.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toThrow("ENOENT");
}

function listOpenFileDescriptorsForPath(targetPath: string): string[] {
  return fsSync.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const descriptorPath = fsSync.readlinkSync(`/proc/self/fd/${fd}`);
      return descriptorPath.startsWith(targetPath) ? [descriptorPath] : [];
    } catch {
      return [];
    }
  });
}

describe("openMemoryDatabaseAtPath readOnly probe", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-db-probe-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows opening when the database file exists", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    const db = openMemoryDatabaseAtPath(dbPath, false);
    expect(db).toBeDefined();
    closeMemoryDatabase(db);
  });

  it("allows creating a new database when allowCreate is true", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "new-index.sqlite");

    const db = openMemoryDatabaseAtPath(dbPath, false, true);
    expect(db).toBeDefined();
    closeMemoryDatabase(db);

    const stat = await fs.stat(dbPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it.skipIf(process.platform !== "linux")(
    "closes the database when SQLite maintenance configuration fails",
    async () => {
      const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "malformed-index.sqlite");
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.writeFile(dbPath, "not a sqlite database");

      expect(() => openMemoryDatabaseAtPath(dbPath, false, false)).toThrow(/not a database/);

      expect(listOpenFileDescriptorsForPath(dbPath)).toEqual([]);
    },
  );

  it("refuses to create a missing live database while a safe reindex holds the lock", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const reindexLock = acquireMemoryReindexLock(dbPath);

    expect(() => openMemoryDatabaseAtPath(dbPath, false, true)).toThrow(
      /another reindex is active/,
    );
    await expectPathMissing(dbPath);

    reindexLock.release();
    const db = openMemoryDatabaseAtPath(dbPath, false, true);
    closeMemoryDatabase(db);
  });

  it("refuses to auto-create an empty database when allowCreate is false", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "absent-index.sqlite");

    expect(() => openMemoryDatabaseAtPath(dbPath, false, false)).toThrow(
      /Memory database not found.*refusing to auto-create/,
    );

    await expect(fs.access(dbPath)).rejects.toThrow("ENOENT");
  });

  it("allows open with allowCreate=true for temp database creation", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "temp-index.sqlite");

    const db = openMemoryReindexTempDatabaseAtPath(dbPath, false);
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    db.close();
    await expectPathMissing(resolveMemoryReindexLockPath(dbPath));

    const reopen = openMemoryDatabaseAtPath(dbPath, false, false);
    expect(reopen).toBeDefined();
    closeMemoryDatabase(reopen);
  });

  it("removes aged orphan reindex temp files before opening the live database", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    const orphanBase = `${dbPath}.tmp-11111111-2222-3333-4444-555555555555`;
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = `${orphanBase}${suffix}`;
      await fs.writeFile(filePath, "orphan");
      const old = new Date(Date.now() - 48 * 60 * 60_000);
      await fs.utimes(filePath, old, old);
    }

    const db = openMemoryDatabaseAtPath(dbPath, false);
    closeMemoryDatabase(db);

    await expectPathMissing(orphanBase);
    await expectPathMissing(`${orphanBase}-wal`);
    await expectPathMissing(`${orphanBase}-shm`);
  });

  it("removes aged orphan reindex temp files including the rollback-journal sidecar", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    // NFS-backed stores keep journal_mode=DELETE, so a hard crash during a
    // reindex leaves a rollback-journal sidecar (.tmp-<uuid>-journal) rather
    // than -wal/-shm. Cleanup must remove it alongside the temp main file.
    const orphanBase = `${dbPath}.tmp-22222222-3333-4444-5555-666666666666`;
    for (const suffix of ["", "-journal"]) {
      const filePath = `${orphanBase}${suffix}`;
      await fs.writeFile(filePath, "orphan");
      const old = new Date(Date.now() - 48 * 60 * 60_000);
      await fs.utimes(filePath, old, old);
    }

    const db = openMemoryDatabaseAtPath(dbPath, false);
    closeMemoryDatabase(db);

    await expectPathMissing(orphanBase);
    await expectPathMissing(`${orphanBase}-journal`);
  });

  it("removes a stranded rollback-journal sidecar whose temp main file is already gone", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    // Only the rollback journal survives (its temp main file was already
    // removed). The discovery set must still recognize the orphan by its
    // -journal suffix, otherwise it leaks forever.
    const strandedJournal = `${dbPath}.tmp-33333333-4444-5555-6666-777777777777-journal`;
    await fs.writeFile(strandedJournal, "stranded journal");
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await fs.utimes(strandedJournal, old, old);

    const db = openMemoryDatabaseAtPath(dbPath, false);
    closeMemoryDatabase(db);

    await expectPathMissing(strandedJournal);
  });

  it("keeps young reindex temp files during live database startup", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    const activeBase = `${dbPath}.tmp-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.writeFile(`${activeBase}${suffix}`, "active");
    }

    const db = openMemoryDatabaseAtPath(dbPath, false);
    closeMemoryDatabase(db);

    await expect(fs.access(activeBase)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-wal`)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-shm`)).resolves.toBeUndefined();
  });

  it("keeps aged reindex temp files while another process holds the reindex lock", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    const activeBase = `${dbPath}.tmp-99999999-aaaa-bbbb-cccc-dddddddddddd`;
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = `${activeBase}${suffix}`;
      await fs.writeFile(filePath, "active");
      const old = new Date(Date.now() - 48 * 60 * 60_000);
      await fs.utimes(filePath, old, old);
    }
    const reindexLock = acquireMemoryReindexLock(dbPath);

    cleanupAgedMemoryReindexTempFiles(dbPath);
    const db = openMemoryDatabaseAtPath(dbPath, false);
    closeMemoryDatabase(db);

    await expect(fs.access(activeBase)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-wal`)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-shm`)).resolves.toBeUndefined();
    reindexLock.release();
    cleanupAgedMemoryReindexTempFiles(dbPath);
    await expectPathMissing(activeBase);
    await expectPathMissing(`${activeBase}-wal`);
    await expectPathMissing(`${activeBase}-shm`);
  });

  it("keeps aged reindex temp files while the live database is absent", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const orphanBase = `${dbPath}.tmp-abcdef12-aaaa-bbbb-cccc-123456789abc`;
    await fs.writeFile(orphanBase, "recovery candidate");
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await fs.utimes(orphanBase, old, old);

    const db = openMemoryDatabaseAtPath(dbPath, false, true);
    closeMemoryDatabase(db);

    await expect(fs.access(orphanBase)).resolves.toBeUndefined();
  });

  it("serializes safe reindexes and releases the lock for the next owner", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });

    const first = acquireMemoryReindexLock(dbPath);
    expect(tryAcquireMemoryReindexLock(dbPath)).toBeUndefined();
    expect(() => acquireMemoryReindexLock(dbPath)).toThrow(/another reindex is active/);

    first.release();
    const second = tryAcquireMemoryReindexLock(dbPath);
    expect(second).toBeDefined();
    second?.release();

    await expect(fs.access(resolveMemoryReindexLockPath(dbPath))).resolves.toBeUndefined();
  });

  it("blocks an atomic swap while a live memory database is open", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.close();

    const db = openMemoryDatabaseAtPath(dbPath, false);
    expect(tryAcquireMemoryReindexSwapLock(dbPath)).toBeUndefined();

    closeMemoryDatabase(db);
    const swapLock = acquireMemoryReindexSwapLock(dbPath);
    swapLock.release();
  });

  it("blocks a live database open while an atomic swap is active", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.close();

    const swapLock = acquireMemoryReindexSwapLock(dbPath);
    expect(() => openMemoryDatabaseAtPath(dbPath, false)).toThrow(
      /unavailable during a safe reindex swap/,
    );
    swapLock.release();

    const db = openMemoryDatabaseAtPath(dbPath, false);
    closeMemoryDatabase(db);
  });

  it("does not block database startup when orphan discovery fails", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.close();
    vi.spyOn(fsSync, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("scan failed"), { code: "EACCES" });
    });

    const db = openMemoryDatabaseAtPath(dbPath, false);
    closeMemoryDatabase(db);
  });
});
