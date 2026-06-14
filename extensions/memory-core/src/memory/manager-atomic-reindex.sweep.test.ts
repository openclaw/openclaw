// Memory Core tests cover startup sweep of orphaned reindex temp files.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepOrphanedReindexTempFiles } from "./manager-atomic-reindex.js";

const TMP_UUID = "11111111-1111-1111-1111-111111111111";

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

async function writeTempTriplet(basePath: string): Promise<void> {
  await fs.writeFile(basePath, "main");
  await fs.writeFile(`${basePath}-wal`, "wal");
  await fs.writeFile(`${basePath}-shm`, "shm");
}

async function ageFile(filePath: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, when, when);
}

describe("sweepOrphanedReindexTempFiles", () => {
  let storeDir = "";
  let dbPath = "";

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-sweep-"));
    dbPath = path.join(storeDir, "index.sqlite");
    await fs.writeFile(dbPath, "live db");
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("removes an aged orphaned reindex temp triplet", async () => {
    const orphanBase = `${dbPath}.tmp-${TMP_UUID}`;
    await writeTempTriplet(orphanBase);
    await ageFile(orphanBase, 5 * 60_000);

    const removed = await sweepOrphanedReindexTempFiles(dbPath, { graceMs: 60_000 });

    expect(removed).toEqual([orphanBase]);
    expect(await pathExists(orphanBase)).toBe(false);
    expect(await pathExists(`${orphanBase}-wal`)).toBe(false);
    expect(await pathExists(`${orphanBase}-shm`)).toBe(false);
    // The live database must survive the sweep.
    expect(await pathExists(dbPath)).toBe(true);
  });

  it("preserves a young temp triplet from a concurrent reindex (race guard)", async () => {
    const activeBase = `${dbPath}.tmp-${TMP_UUID}`;
    await writeTempTriplet(activeBase);
    // Freshly modified (within the grace window): a live reindex may own it.

    const removed = await sweepOrphanedReindexTempFiles(dbPath, { graceMs: 60_000 });

    expect(removed).toEqual([]);
    expect(await pathExists(activeBase)).toBe(true);
    expect(await pathExists(`${activeBase}-wal`)).toBe(true);
    expect(await pathExists(`${activeBase}-shm`)).toBe(true);
  });

  it("does not touch the live db, backups, or unrelated databases", async () => {
    const backupBase = `${dbPath}.backup-${TMP_UUID}`;
    await fs.writeFile(backupBase, "backup");
    await ageFile(backupBase, 5 * 60_000);
    const otherDb = path.join(storeDir, "other.sqlite");
    await fs.writeFile(otherDb, "other");
    await ageFile(otherDb, 5 * 60_000);
    // A temp belonging to a *different* base DB must not be swept by this db's run.
    const foreignTemp = `${otherDb}.tmp-${TMP_UUID}`;
    await writeTempTriplet(foreignTemp);
    await ageFile(foreignTemp, 5 * 60_000);

    const removed = await sweepOrphanedReindexTempFiles(dbPath, { graceMs: 60_000 });

    expect(removed).toEqual([]);
    expect(await pathExists(dbPath)).toBe(true);
    expect(await pathExists(backupBase)).toBe(true);
    expect(await pathExists(otherDb)).toBe(true);
    expect(await pathExists(foreignTemp)).toBe(true);
  });

  it("removes multiple aged orphans while keeping young ones", async () => {
    const oldA = `${dbPath}.tmp-${TMP_UUID}`;
    const oldB = `${dbPath}.tmp-22222222-2222-2222-2222-222222222222`;
    const fresh = `${dbPath}.tmp-33333333-3333-3333-3333-333333333333`;
    await writeTempTriplet(oldA);
    await writeTempTriplet(oldB);
    await writeTempTriplet(fresh);
    await ageFile(oldA, 5 * 60_000);
    await ageFile(oldB, 5 * 60_000);

    const removed = await sweepOrphanedReindexTempFiles(dbPath, { graceMs: 60_000 });

    expect(removed.sort()).toEqual([oldA, oldB].sort());
    expect(await pathExists(oldA)).toBe(false);
    expect(await pathExists(oldB)).toBe(false);
    expect(await pathExists(fresh)).toBe(true);
  });

  it("returns an empty list when the store directory does not exist", async () => {
    const missing = path.join(storeDir, "nope", "index.sqlite");

    await expect(sweepOrphanedReindexTempFiles(missing)).resolves.toEqual([]);
  });
});
