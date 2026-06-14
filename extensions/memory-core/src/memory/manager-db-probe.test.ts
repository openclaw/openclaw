import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openMemoryDatabaseAtPath } from "./manager-db.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toThrow("ENOENT");
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
    db.close();
  });

  it("allows creating a new database when allowCreate is true", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "new-index.sqlite");

    const db = openMemoryDatabaseAtPath(dbPath, false, true);
    expect(db).toBeDefined();
    db.close();

    const stat = await fs.stat(dbPath);
    expect(stat.size).toBeGreaterThan(0);
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

    const db = openMemoryDatabaseAtPath(dbPath, false, true);
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    db.close();

    const reopen = openMemoryDatabaseAtPath(dbPath, false, false);
    expect(reopen).toBeDefined();
    reopen.close();
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
    db.close();

    await expectPathMissing(orphanBase);
    await expectPathMissing(`${orphanBase}-wal`);
    await expectPathMissing(`${orphanBase}-shm`);
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
    db.close();

    await expect(fs.access(activeBase)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-wal`)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-shm`)).resolves.toBeUndefined();
  });

  it("keeps aged reindex temp files when their owner process is live", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    const activeBase = `${dbPath}.tmp-99999999-aaaa-bbbb-cccc-dddddddddddd`;
    for (const suffix of ["", "-wal", "-shm", ".lock"]) {
      const filePath = `${activeBase}${suffix}`;
      await fs.writeFile(
        filePath,
        suffix === ".lock" ? JSON.stringify({ pid: process.pid }) : "active",
      );
      const old = new Date(Date.now() - 60 * 60_000);
      await fs.utimes(filePath, old, old);
    }

    const db = openMemoryDatabaseAtPath(dbPath, false);
    db.close();

    await expect(fs.access(activeBase)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-wal`)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}-shm`)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}.lock`)).resolves.toBeUndefined();
  });

  it("removes aged orphan reindex temp files with a stale owner lock", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    seed.close();

    const orphanBase = `${dbPath}.tmp-12345678-aaaa-bbbb-cccc-123456789abc`;
    for (const suffix of ["", "-wal", "-shm", ".lock"]) {
      const filePath = `${orphanBase}${suffix}`;
      await fs.writeFile(filePath, suffix === ".lock" ? '{"pid":999999999}' : "orphan");
      const old = new Date(Date.now() - 60 * 60_000);
      await fs.utimes(filePath, old, old);
    }

    const db = openMemoryDatabaseAtPath(dbPath, false);
    db.close();

    await expectPathMissing(orphanBase);
    await expectPathMissing(`${orphanBase}-wal`);
    await expectPathMissing(`${orphanBase}-shm`);
    await expectPathMissing(`${orphanBase}.lock`);
  });

  it("removes an aged lock-only reindex orphan", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.close();

    const orphanLock = `${dbPath}.tmp-87654321-aaaa-bbbb-cccc-123456789abc.lock`;
    await fs.writeFile(orphanLock, '{"pid":999999999}');
    const old = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(orphanLock, old, old);

    const db = openMemoryDatabaseAtPath(dbPath, false);
    db.close();

    await expectPathMissing(orphanLock);
  });

  it("keeps aged reindex temp files while the live database is absent", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const orphanBase = `${dbPath}.tmp-abcdef12-aaaa-bbbb-cccc-123456789abc`;
    await fs.writeFile(orphanBase, "recovery candidate");
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await fs.utimes(orphanBase, old, old);

    const db = openMemoryDatabaseAtPath(dbPath, false, true);
    db.close();

    await expect(fs.access(orphanBase)).resolves.toBeUndefined();
  });

  it("keeps aged reindex temp files when owner liveness is uncertain", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.close();

    const activeBase = `${dbPath}.tmp-fedcba98-aaaa-bbbb-cccc-123456789abc`;
    await fs.writeFile(activeBase, "active");
    await fs.writeFile(`${activeBase}.lock`, '{"pid":12345}');
    const old = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(activeBase, old, old);
    await fs.utimes(`${activeBase}.lock`, old, old);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("unknown process state"), { code: "EACCES" });
    });

    const db = openMemoryDatabaseAtPath(dbPath, false);
    db.close();

    await expect(fs.access(activeBase)).resolves.toBeUndefined();
    await expect(fs.access(`${activeBase}.lock`)).resolves.toBeUndefined();
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
    db.close();
  });
});
