import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type DatabaseInstance = InstanceType<typeof Database>;

/**
 * Create or open a SQLite database with WAL mode and standard pragmas.
 */
export function createDatabase(dbPath: string): DatabaseInstance {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
