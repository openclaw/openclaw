// Memory Core plugin module implements manager db behavior.
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  allowCreate = true,
): DatabaseSync {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
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
      if (
        msg.includes("unable to open database file") ||
        msg.includes("SQLITE_CANTOPEN")
      ) {
        throw new Error(
          `Memory database not found at ${dbPath}; refusing to auto-create an empty database during an index swap window.`,
          { cause: err },
        );
      }
    }
  }
  const db = new DatabaseSync(dbPath, { allowExtension });
  configureMemorySqliteWalMaintenance(db);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function closeMemoryDatabase(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
}
