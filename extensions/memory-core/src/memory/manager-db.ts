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

const staleReindexTempGraceMs = 60_000;
const sqliteSidecarSuffixes = ["", "-wal", "-shm"] as const;

export function sweepStaleMemoryIndexTempFiles(
  dbPath: string,
  options: { nowMs?: number; graceMs?: number } = {},
): number {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const prefix = `${base}.tmp-`;
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? staleReindexTempGraceMs;

  let liveStat: fs.Stats;
  try {
    liveStat = fs.statSync(dbPath);
  } catch {
    return 0;
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.endsWith("-wal") || entry.endsWith("-shm")) {
      continue;
    }

    const tempPath = path.join(dir, entry);
    let tempStat: fs.Stats;
    try {
      tempStat = fs.statSync(tempPath);
    } catch {
      continue;
    }
    if (!tempStat.isFile()) {
      continue;
    }
    if (nowMs - tempStat.mtimeMs < graceMs) {
      continue;
    }
    if (liveStat.mtimeMs < tempStat.mtimeMs) {
      continue;
    }

    for (const suffix of sqliteSidecarSuffixes) {
      const targetPath = `${tempPath}${suffix}`;
      if (!fs.existsSync(targetPath)) {
        continue;
      }
      try {
        fs.rmSync(targetPath, { force: true });
        removed += 1;
      } catch {
        // Startup cleanup is best-effort. If another process still owns the
        // temp file or the platform refuses deletion, keep opening the live DB.
      }
    }
  }
  return removed;
}

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  allowCreate = true,
): DatabaseSync {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  sweepStaleMemoryIndexTempFiles(dbPath);
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
