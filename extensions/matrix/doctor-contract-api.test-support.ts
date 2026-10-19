import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateMigrations } from "./doctor-contract-api.js";

export function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

export function writeSqliteDedupeSource(
  storageRootDir: string,
  accountId: string,
  eventId: string,
  ts: number,
): string {
  const databasePath = path.join(storageRootDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const roomId = "!room:example.org";
  const key = `${accountId}:${createHash("sha256")
    .update(`${accountId}\0${roomId}\0${eventId}`)
    .digest("hex")}`;
  const db = new DatabaseSync(databasePath);
  try {
    // July's per-account store used this row shape and schema version.
    db.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (plugin_id, namespace, entry_key)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    db.prepare(`
      INSERT INTO plugin_state_entries VALUES ('matrix', 'inbound-dedupe', ?, ?, ?, NULL)
    `).run(key, JSON.stringify({ roomId, eventId, ts }), ts);
  } finally {
    db.close();
  }
  return databasePath;
}

export function writeLegacySyncCache(storageRootDir: string, nextBatch: string): void {
  fs.mkdirSync(storageRootDir, { recursive: true });
  fs.writeFileSync(
    path.join(storageRootDir, "bot-storage.json"),
    JSON.stringify({
      version: 1,
      savedSync: {
        nextBatch,
        accountData: [],
        roomsData: { join: {}, invite: {}, leave: {}, knock: {} },
      },
      cleanShutdown: true,
    }),
  );
}
