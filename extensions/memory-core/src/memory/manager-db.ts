// Memory Core plugin module implements manager db behavior.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// Hard-killed safe reindexes cannot run JS cleanup on their temp DB triplet.
// Startup only removes old sibling triplets so another live process can still
// own a young temp DB without losing its in-flight rebuild.
const reindexTempFileMinAgeMs = 10 * 60_000;
const reindexTempFileWithoutLockMinAgeMs = 24 * 60 * 60_000;
const reindexTempUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const memoryIndexFileSuffixes = ["", "-wal", "-shm"] as const;

function resolveReindexTempBaseName(dbBaseName: string, entryName: string): string | undefined {
  for (const suffix of memoryIndexFileSuffixes) {
    if (!entryName.endsWith(suffix)) {
      continue;
    }
    const baseName = entryName.slice(0, entryName.length - suffix.length);
    const tempPrefix = `${dbBaseName}.tmp-`;
    if (!baseName.startsWith(tempPrefix)) {
      continue;
    }
    const uuid = baseName.slice(tempPrefix.length);
    if (reindexTempUuidPattern.test(uuid)) {
      return baseName;
    }
  }
  return undefined;
}

function readReindexTempLockPid(lockPath: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("pid" in parsed)) {
      return undefined;
    }
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function cleanupAgedReindexTempFiles(dbPath: string, nowMs = Date.now()): void {
  const dir = path.dirname(dbPath);
  const dbBaseName = path.basename(dbPath);
  const tempBaseNames = new Set<string>();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const tempBaseName = resolveReindexTempBaseName(dbBaseName, entry.name);
    if (tempBaseName) {
      tempBaseNames.add(tempBaseName);
    }
  }

  for (const tempBaseName of tempBaseNames) {
    const lockPath = path.join(dir, `${tempBaseName}.lock`);
    const lockPid = readReindexTempLockPid(lockPath);
    if (lockPid && isProcessRunning(lockPid)) {
      continue;
    }
    const filePaths = [
      ...memoryIndexFileSuffixes.map((suffix) => path.join(dir, `${tempBaseName}${suffix}`)),
      lockPath,
    ];
    const stats = filePaths
      .map((filePath) => {
        try {
          return fs.statSync(filePath);
        } catch {
          return undefined;
        }
      })
      .filter((stat): stat is fs.Stats => stat !== undefined);
    if (stats.length === 0) {
      continue;
    }
    const newestMtimeMs = Math.max(...stats.map((stat) => stat.mtimeMs));
    const minAgeMs = lockPid ? reindexTempFileMinAgeMs : reindexTempFileWithoutLockMinAgeMs;
    if (nowMs - newestMtimeMs < minAgeMs) {
      continue;
    }
    for (const filePath of filePaths) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {}
    }
  }
}

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  allowCreate = true,
): DatabaseSync {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  cleanupAgedReindexTempFiles(dbPath);
  const { DatabaseSync } = requireNodeSqlite();
  // When allowCreate is false, probe with readOnly first.
  // DatabaseSync auto-creates the file in read-write mode, which
  // produces an empty database with schema but no meta row when the
  // file is momentarily absent during an index swap. readOnly: true
  // throws SQLITE_CANTOPEN when the file does not exist, preventing
  // the auto-create race.
  if (!allowCreate) {
    try {
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      probe.close();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("unable to open database file") || msg.includes("SQLITE_CANTOPEN")) {
        throw new Error(
          `Memory database not found at ${dbPath}; refusing to auto-create an empty database during an index swap window.`,
          { cause: err },
        );
      }
    }
  }
  const db = new DatabaseSync(dbPath, { allowExtension });
  configureMemorySqliteWalMaintenance(db, { databasePath: dbPath });
  // busy_timeout is per-connection and resets to 0 on restart.
  // Set it on every open so concurrent processes retry instead of
  // failing immediately with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function closeMemoryDatabase(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
}
