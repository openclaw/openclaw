import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Retain the shipped native-v0 input so package acceptance proves its upgrade
// into the local credential owner before node startup.
export function seedMacNodeWorkerProofState(databasePath) {
  const source = fs.readFileSync(
    new URL(
      "../../apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift",
      import.meta.url,
    ),
    "utf8",
  );
  const statements = [...source.matchAll(/createSQL: """\n([\s\S]*?)\n\s*"""/gu)];
  assert.equal(statements.length, 4, "Native bootstrap DDL must be extracted completely");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    for (const [, sql] of statements) {
      db.exec(sql);
    }
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
