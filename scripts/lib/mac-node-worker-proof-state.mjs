import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Frozen native-v0 schema: upgrade proof must not derive its input from the current app.
const legacyNativeV0Schema = `
CREATE TABLE IF NOT EXISTS device_identities (
  identity_key TEXT NOT NULL PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  private_key_pem TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_device_identities_device
  ON device_identities(device_id, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS device_auth_tokens (
  device_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, role)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_device_auth_tokens_updated
  ON device_auth_tokens(updated_at_ms DESC, device_id, role);

CREATE TABLE IF NOT EXISTS macos_port_guardian_records (
  pid INTEGER NOT NULL PRIMARY KEY,
  port INTEGER NOT NULL,
  command TEXT NOT NULL,
  mode TEXT NOT NULL,
  timestamp REAL NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_macos_port_guardian_records_port
  ON macos_port_guardian_records(port, timestamp DESC);

CREATE TABLE IF NOT EXISTS exec_approvals_config (
  config_key TEXT NOT NULL PRIMARY KEY,
  raw_json TEXT NOT NULL,
  socket_path TEXT,
  has_socket_token INTEGER NOT NULL,
  default_security TEXT,
  default_ask TEXT,
  default_ask_fallback TEXT,
  auto_allow_skills INTEGER,
  agent_count INTEGER NOT NULL,
  allowlist_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;
`;

export function seedMacNodeWorkerProofState(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(legacyNativeV0Schema);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ type: "spki", format: "der" });
    const deviceId = createHash("sha256").update(publicDer.subarray(-32)).digest("hex");
    db.prepare("INSERT INTO device_identities VALUES (?, ?, ?, ?, ?, ?)").run(
      "node",
      deviceId,
      publicKey.export({ type: "spki", format: "pem" }),
      privateKey.export({ type: "pkcs8", format: "pem" }),
      1,
      1,
    );
    db.prepare("INSERT INTO device_auth_tokens VALUES (?, ?, ?, ?, ?)").run(
      deviceId,
      "node",
      "synthetic-native-token",
      "[]",
      1,
    );
    db.prepare("INSERT INTO exec_approvals_config VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "current",
      '{"version":1,"defaults":{"security":"deny"},"agents":{}}',
      null,
      0,
      "deny",
      null,
      null,
      null,
      0,
      0,
      1,
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
    return readMacNodeWorkerProofRows(db);
  } finally {
    db.close();
  }
}

export function readMacNodeWorkerProofRows(db, credentialDatabasePath) {
  const credentials = credentialDatabasePath
    ? new DatabaseSync(credentialDatabasePath, { readOnly: true })
    : db;
  try {
    return [
      credentials.prepare("SELECT * FROM device_identities").all(),
      credentials.prepare("SELECT * FROM device_auth_tokens").all(),
      db.prepare("SELECT * FROM exec_approvals_config").all(),
    ];
  } finally {
    if (credentials !== db) {
      credentials.close();
    }
  }
}
