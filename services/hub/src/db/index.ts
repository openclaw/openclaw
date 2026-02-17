import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SCHEMA } from "./schema.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialised — call initDb() first");
  }
  return db;
}

function tableExists(d: Database.Database, name: string): boolean {
  const row = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) as
    | { 1: number }
    | undefined;
  return row !== undefined;
}

function migrateInstallations(d: Database.Database): void {
  if (!tableExists(d, "installations")) {
    return;
  }

  // Add container_id column to instances if missing
  const instanceCols = d.pragma("table_info(instances)") as Array<{ name: string }>;
  if (!instanceCols.some((c) => c.name === "container_id")) {
    d.exec("ALTER TABLE instances ADD COLUMN container_id TEXT");
  }

  console.log("Migrating installations → connections...");

  type OldRow = {
    team_id: string;
    team_name: string | null;
    instance_id: string;
    bot_token: string;
    bot_user_id: string | null;
    installed_at: number;
  };

  const rows = d.prepare("SELECT * FROM installations").all() as OldRow[];

  const insert = d.prepare(
    `INSERT OR IGNORE INTO connections (id, instance_id, provider, external_id, external_name, credentials, connected_at)
     VALUES (?, ?, 'slack', ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    const creds = JSON.stringify({ botToken: row.bot_token, botUserId: row.bot_user_id });
    insert.run(randomUUID(), row.instance_id, row.team_id, row.team_name, creds, row.installed_at);
  }

  d.exec("DROP TABLE installations");
  console.log(`Migrated ${rows.length} installation(s) to connections.`);
}

function migrateDeviceCredentials(d: Database.Database): void {
  if (!tableExists(d, "instances")) {
    return;
  }
  const cols = d.pragma("table_info(instances)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "device_credentials")) {
    d.exec("ALTER TABLE instances ADD COLUMN device_credentials TEXT");
  }
}

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrateInstallations(db);
  migrateDeviceCredentials(db);
  return db;
}
