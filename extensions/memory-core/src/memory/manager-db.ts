import path from "node:path";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  requireBetterSqlite3,
  type MemoryDb,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function openMemoryDatabaseAtPath(dbPath: string): MemoryDb {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const BetterSqlite3 = requireBetterSqlite3();
  const db = new BetterSqlite3(dbPath);
  configureMemorySqliteWalMaintenance(db);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function closeMemoryDatabase(db: MemoryDb): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
}
