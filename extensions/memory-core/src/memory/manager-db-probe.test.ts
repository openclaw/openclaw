import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openMemoryDatabaseAtPath, sweepStaleMemoryIndexTempFiles } from "./manager-db.js";

describe("openMemoryDatabaseAtPath readOnly probe", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-db-probe-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
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

  it("sweeps stale atomic reindex temp sqlite triplets", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, "live");

    const tempPath = `${dbPath}.tmp-old`;
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.writeFile(`${tempPath}${suffix}`, `temp${suffix}`);
    }

    const now = Date.now();
    const liveTime = new Date(now - 120_000);
    const tempTime = new Date(now - 180_000);
    await fs.utimes(dbPath, liveTime, liveTime);
    await fs.utimes(tempPath, tempTime, tempTime);

    expect(sweepStaleMemoryIndexTempFiles(dbPath, { nowMs: now, graceMs: 60_000 })).toBe(3);
    await expect(fs.access(tempPath)).rejects.toThrow("ENOENT");
    await expect(fs.access(`${tempPath}-wal`)).rejects.toThrow("ENOENT");
    await expect(fs.access(`${tempPath}-shm`)).rejects.toThrow("ENOENT");
  });

  it("keeps young or newer atomic reindex temp sqlite files", async () => {
    const dbPath = path.join(fixtureRoot, `case-${caseId++}`, "index.sqlite");
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    await fs.writeFile(dbPath, "live");

    const youngTempPath = `${dbPath}.tmp-young`;
    const newerTempPath = `${dbPath}.tmp-newer`;
    await fs.writeFile(youngTempPath, "young");
    await fs.writeFile(newerTempPath, "newer");

    const now = Date.now();
    const liveTime = new Date(now - 120_000);
    await fs.utimes(dbPath, liveTime, liveTime);
    await fs.utimes(youngTempPath, new Date(now - 10_000), new Date(now - 10_000));
    await fs.utimes(newerTempPath, new Date(now - 30_000), new Date(now - 30_000));

    expect(sweepStaleMemoryIndexTempFiles(dbPath, { nowMs: now, graceMs: 60_000 })).toBe(0);
    await expect(fs.access(youngTempPath)).resolves.toBeUndefined();
    await expect(fs.access(newerTempPath)).resolves.toBeUndefined();
  });
});
