import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const KV_SCOPE = "installed_plugin_index";
const KV_KEY = "current";

function allowLegacyPackageCompatFallback() {
  return process.env.OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT === "1";
}

export function openclawStateDir() {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function stateDbPath() {
  return path.join(openclawStateDir(), "state", "openclaw.sqlite");
}

function openStateDb() {
  const dbPath = stateDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    )
  `);
  return db;
}

export function readInstalledPluginIndex(options = {}) {
  try {
    const db = openStateDb();
    try {
      const row = db
        .prepare("SELECT value_json FROM kv WHERE scope = ? AND key = ?")
        .get(KV_SCOPE, KV_KEY);
      if (row?.value_json) {
        return JSON.parse(row.value_json);
      }
    } finally {
      db.close();
    }
  } catch {
    // Fall through to optional legacy compatibility.
  }
  if (options.allowLegacyFile && allowLegacyPackageCompatFallback()) {
    return readJsonIfExists(path.join(openclawStateDir(), "plugins", "installs.json"));
  }
  return {};
}

export function writeInstalledPluginIndex(index) {
  const db = openStateDb();
  try {
    db.prepare(
      "INSERT INTO kv (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    ).run(KV_SCOPE, KV_KEY, JSON.stringify(index), Date.now());
  } finally {
    db.close();
  }
}

export function readInstalledPluginRecords(options = {}) {
  const index = readInstalledPluginIndex(options);
  if (index.installRecords) {
    return index.installRecords;
  }
  if (!allowLegacyPackageCompatFallback()) {
    return {};
  }
  const config = readJsonIfExists(path.join(openclawStateDir(), "openclaw.json"));
  return index.records ?? config.plugins?.installs ?? {};
}
