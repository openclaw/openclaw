import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const INSTALLED_PLUGIN_INDEX_KEY = "current";

export function openclawStateDir() {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

function stateDbPath() {
  return path.join(openclawStateDir(), "state", "openclaw.sqlite");
}

function openStateDb() {
  const dbPath = stateDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_plugin_index (
      index_key TEXT NOT NULL PRIMARY KEY,
      version INTEGER NOT NULL,
      host_contract_version TEXT NOT NULL,
      compat_registry_version TEXT NOT NULL,
      migration_version INTEGER NOT NULL,
      policy_hash TEXT NOT NULL,
      generated_at_ms INTEGER NOT NULL,
      refresh_reason TEXT,
      install_records_json TEXT NOT NULL,
      plugins_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      warning TEXT,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  return db;
}

function parseJsonColumn(value, fallback) {
  try {
    return typeof value === "string" ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function installedPluginIndexFromRow(row) {
  if (!row) {
    return null;
  }
  return {
    version: Number(row.version),
    ...(row.warning ? { warning: String(row.warning) } : {}),
    hostContractVersion: String(row.host_contract_version),
    compatRegistryVersion: String(row.compat_registry_version),
    migrationVersion: Number(row.migration_version),
    policyHash: String(row.policy_hash),
    generatedAtMs: Number(row.generated_at_ms),
    ...(row.refresh_reason ? { refreshReason: String(row.refresh_reason) } : {}),
    installRecords: parseJsonColumn(row.install_records_json, {}),
    plugins: parseJsonColumn(row.plugins_json, []),
    diagnostics: parseJsonColumn(row.diagnostics_json, []),
  };
}

export function readInstalledPluginIndex() {
  try {
    const db = openStateDb();
    try {
      const row = db
        .prepare("SELECT * FROM installed_plugin_index WHERE index_key = ?")
        .get(INSTALLED_PLUGIN_INDEX_KEY);
      return installedPluginIndexFromRow(row) ?? {};
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

export function writeInstalledPluginIndex(index) {
  const db = openStateDb();
  try {
    db.prepare(
      `INSERT INTO installed_plugin_index (
        index_key,
        version,
        host_contract_version,
        compat_registry_version,
        migration_version,
        policy_hash,
        generated_at_ms,
        refresh_reason,
        install_records_json,
        plugins_json,
        diagnostics_json,
        warning,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(index_key) DO UPDATE SET
        version = excluded.version,
        host_contract_version = excluded.host_contract_version,
        compat_registry_version = excluded.compat_registry_version,
        migration_version = excluded.migration_version,
        policy_hash = excluded.policy_hash,
        generated_at_ms = excluded.generated_at_ms,
        refresh_reason = excluded.refresh_reason,
        install_records_json = excluded.install_records_json,
        plugins_json = excluded.plugins_json,
        diagnostics_json = excluded.diagnostics_json,
        warning = excluded.warning,
        updated_at_ms = excluded.updated_at_ms`,
    ).run(
      INSTALLED_PLUGIN_INDEX_KEY,
      Number(index.version ?? 1),
      String(index.hostContractVersion ?? "e2e"),
      String(index.compatRegistryVersion ?? "e2e"),
      Number(index.migrationVersion ?? 1),
      String(index.policyHash ?? "e2e"),
      Number(index.generatedAtMs ?? Date.now()),
      index.refreshReason ? String(index.refreshReason) : null,
      JSON.stringify(index.installRecords ?? index.records ?? {}),
      JSON.stringify(index.plugins ?? []),
      JSON.stringify(index.diagnostics ?? []),
      index.warning ? String(index.warning) : null,
      Number(index.updatedAtMs ?? Date.now()),
    );
  } finally {
    db.close();
  }
}

export function readInstalledPluginRecords() {
  return readInstalledPluginIndex().installRecords ?? {};
}
