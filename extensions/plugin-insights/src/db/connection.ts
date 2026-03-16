import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { runMigrations } from "./migration.js";

/**
 * Create a new database connection instance.
 * Each caller owns its own connection — no hidden singleton.
 */
export function createDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db);
  return db;
}

/** Create an in-memory database for testing */
export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
