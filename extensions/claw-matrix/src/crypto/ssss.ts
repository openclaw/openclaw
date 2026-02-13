/**
 * SSSS (Secret Storage) decryption and cross-signing key restoration.
 *
 * On startup, if the local crypto store has no cross-signing private keys
 * but they exist on the server (encrypted in SSSS), this module decrypts
 * them using the configured recovery key and inserts them into the SQLite
 * store BEFORE OlmMachine initialization — so crossSigningStatus() finds
 * them and the destructive bootstrapCrossSigning(true) path is never hit.
 *
 * Crypto: m.secret_storage.v1.aes-hmac-sha2 (MSC1946)
 *   HKDF-SHA-256(IKM=recoveryKey, salt=32×0x00, info=secretName, L=64)
 *   → AES-256-CTR + HMAC-SHA-256
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import type { PluginLogger } from "../openclaw-types.js";
import { matrixFetch } from "../client/http.js";
import { createLogger } from "../util/logger.js";
import { decodeRecoveryKey } from "./recovery.js";

// Module-level flag: did the server have cross-signing keys during this startup?
let _serverHasCrossSigningKeys = false;

export function serverHasCrossSigningKeys(): boolean {
  return _serverHasCrossSigningKeys;
}

const CROSS_SIGNING_SECRETS = [
  "m.cross_signing.master",
  "m.cross_signing.self_signing",
  "m.cross_signing.user_signing",
] as const;

export interface SsssRestoreResult {
  restored: boolean;
  /** Decrypted ed25519 seeds (base64), only set if restored=true */
  secrets?: {
    master: string;
    selfSigning: string;
    userSigning: string;
  };
}

// ── SSSS Decryption ─────────────────────────────────────────────────────

interface EncryptedData {
  ciphertext: string;
  iv: string;
  mac: string;
}

interface KeyMetadata {
  algorithm?: string;
  iv?: string;
  mac?: string;
}

/**
 * Decrypt a single SSSS secret using m.secret_storage.v1.aes-hmac-sha2.
 *
 * @param rawKey  32-byte recovery key (from decodeRecoveryKey)
 * @param secretName  e.g. "m.cross_signing.master" — used as HKDF info
 * @param encrypted  {ciphertext, iv, mac} from the encrypted block
 * @returns Decrypted plaintext (base64-encoded ed25519 seed for cross-signing)
 */
function decryptSecret(rawKey: Uint8Array, secretName: string, encrypted: EncryptedData): string {
  // HKDF-SHA-256: derive AES key (32B) + HMAC key (32B)
  const salt = Buffer.alloc(32, 0);
  const derived = crypto.hkdfSync("sha256", rawKey, salt, secretName, 64);
  const aesKey = Buffer.from(derived.slice(0, 32));
  const hmacKey = Buffer.from(derived.slice(32, 64));

  const ciphertextBuf = Buffer.from(encrypted.ciphertext, "base64");

  // Verify HMAC-SHA-256
  const hmac = crypto.createHmac("sha256", hmacKey).update(ciphertextBuf).digest();
  const expectedMac = Buffer.from(encrypted.mac, "base64");
  if (!hmac.equals(expectedMac)) {
    throw new Error(`HMAC mismatch for ${secretName}`);
  }

  // AES-256-CTR decrypt
  const iv = Buffer.from(encrypted.iv, "base64");
  const decipher = crypto.createDecipheriv("aes-256-ctr", aesKey, iv);
  return Buffer.concat([decipher.update(ciphertextBuf), decipher.final()]).toString("utf8");
}

/**
 * Verify that a recovery key matches the SSSS key metadata.
 *
 * Uses HKDF-SHA-256 with info="" (empty string) — distinct from per-secret
 * decryption which uses secretName as info.
 */
function verifyRecoveryKey(rawKey: Uint8Array, keyMeta: KeyMetadata): boolean {
  if (!keyMeta.iv || !keyMeta.mac) return false;

  const salt = Buffer.alloc(32, 0);
  // HKDF info is empty string for key self-verification
  const derived = crypto.hkdfSync("sha256", rawKey, salt, "", 64);
  const aesKey = Buffer.from(derived.slice(0, 32));
  const hmacKey = Buffer.from(derived.slice(32, 64));

  // Encrypt 32 zero bytes with AES-256-CTR
  const zeros = Buffer.alloc(32, 0);
  const iv = Buffer.from(keyMeta.iv, "base64");
  const cipher = crypto.createCipheriv("aes-256-ctr", aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(zeros), cipher.final()]);

  // HMAC-SHA-256 the encrypted output
  const hmac = crypto.createHmac("sha256", hmacKey).update(encrypted).digest();
  const expectedMac = Buffer.from(keyMeta.mac, "base64");
  return hmac.equals(expectedMac);
}

// ── SQLite helpers ──────────────────────────────────────────────────────
//
// CRITICAL: These functions use Node's node:sqlite (DatabaseSync) to access
// the crypto store. The Rust SDK (@matrix-org/matrix-sdk-crypto-nodejs)
// bundles its OWN SQLite — two different SQLite implementations accessing
// the same DB concurrently causes WAL corruption.
//
// ALL node:sqlite access MUST happen BEFORE initCryptoMachine() opens the
// DB via the Rust FFI. The monitor.ts startup sequence enforces this:
//   1. restoreCrossSigningFromSSSSIfNeeded() — node:sqlite (safe)
//   2. readLocalSskSeed() — node:sqlite (safe)
//   3. initCryptoMachine() — Rust SQLite (takes ownership)
//   After step 3, node:sqlite MUST NOT touch the DB.

function openCryptoDb(storePath: string) {
  const dbPath = path.join(storePath, "matrix-sdk-crypto.sqlite3");
  // node:sqlite is available in Node.js >=22
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(dbPath);
}

/**
 * Checkpoint WAL and close the database, ensuring all data is flushed
 * to the main .sqlite3 file before the Rust SDK opens it.
 */
function safeCloseDb(db: ReturnType<typeof openCryptoDb>): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // WAL may not exist yet (first run) or DB opened read-only
  }
  db.close();
}

function localSecretsExist(storePath: string): boolean {
  try {
    const db = openCryptoDb(storePath);
    try {
      const row = db
        .prepare("SELECT count(*) as n FROM secrets WHERE secret_name = ?")
        .get(Buffer.from("m.cross_signing.master", "utf8")) as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    } finally {
      safeCloseDb(db);
    }
  } catch {
    // DB doesn't exist yet or table missing — no secrets
    return false;
  }
}

function insertSecrets(storePath: string, secrets: Array<{ name: string; value: string }>): void {
  const db = openCryptoDb(storePath);
  try {
    // Create table if missing (fresh DB before OlmMachine first init)
    db.exec("CREATE TABLE IF NOT EXISTS secrets (secret_name BLOB NOT NULL, data BLOB NOT NULL)");
    const del = db.prepare("DELETE FROM secrets WHERE secret_name = ?");
    const ins = db.prepare("INSERT INTO secrets (secret_name, data) VALUES (?, ?)");
    for (const { name, value } of secrets) {
      const nameBuf = Buffer.from(name, "utf8");
      const dataBuf = Buffer.from(value, "utf8");
      del.run(nameBuf);
      ins.run(nameBuf, dataBuf);
    }
  } finally {
    safeCloseDb(db);
  }
}

/**
 * Read the self-signing key seed from the local crypto store.
 * Returns the base64-encoded seed, or undefined if not found.
 *
 * MUST be called BEFORE initCryptoMachine() — see comment block above.
 */
export function readLocalSskSeed(storePath: string): string | undefined {
  try {
    const db = openCryptoDb(storePath);
    try {
      const row = db
        .prepare("SELECT data FROM secrets WHERE secret_name = ?")
        .get(Buffer.from("m.cross_signing.self_signing", "utf8")) as { data: Buffer } | undefined;
      return row?.data ? row.data.toString("utf8") : undefined;
    } finally {
      safeCloseDb(db);
    }
  } catch {
    return undefined;
  }
}

// ── Server queries ──────────────────────────────────────────────────────

async function serverCrossSigningKeysExist(userId: string): Promise<boolean> {
  try {
    const resp = await matrixFetch<{
      master_keys?: Record<string, unknown>;
    }>("POST", "/_matrix/client/v3/keys/query", {
      device_keys: { [userId]: [] },
    });
    const has = !!(resp.master_keys && resp.master_keys[userId]);
    _serverHasCrossSigningKeys = has;
    return has;
  } catch {
    return false;
  }
}

async function fetchAccountData<T>(userId: string, type: string): Promise<T | undefined> {
  try {
    return await matrixFetch<T>(
      "GET",
      `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`,
    );
  } catch {
    return undefined;
  }
}

// ── Main entry point ────────────────────────────────────────────────────

export interface RestoreOpts {
  storePath: string;
  recoveryKey?: string;
  userId: string;
  log?: PluginLogger;
}

/**
 * Restore cross-signing private keys from SSSS into the local SQLite store.
 *
 * Decision tree:
 * 1. Local secrets exist? → skip (return restored=false)
 * 2. Server has cross-signing keys?
 *    - NO  → return restored=false (caller may bootstrap)
 *    - YES + no recoveryKey → log warning, return restored=false (DON'T bootstrap)
 *    - YES + recoveryKey → verify key, decrypt SSSS, insert, return restored=true + secrets
 */
export async function restoreCrossSigningFromSSSSIfNeeded(
  opts: RestoreOpts,
): Promise<SsssRestoreResult> {
  const { storePath, recoveryKey, userId, log } = opts;
  const slog = createLogger("matrix", log);
  const fail: SsssRestoreResult = { restored: false };

  // 1. Check server — always query so the guard flag is set for monitor.ts
  const serverHas = await serverCrossSigningKeysExist(userId);

  // 2. Check local store
  if (localSecretsExist(storePath)) {
    return fail; // Already have local keys
  }

  if (!serverHas) {
    return fail; // Truly no keys — caller can bootstrap
  }

  // 3. Keys on server but no recovery key
  if (!recoveryKey) {
    slog.warn(
      "Cross-signing keys exist on server but no recoveryKey configured — " +
        "cannot restore locally. Device will remain unverified.",
    );
    return fail;
  }

  // 4. Decode recovery key
  let rawKey: Uint8Array;
  try {
    rawKey = await decodeRecoveryKey(recoveryKey);
  } catch (err: any) {
    slog.error("Failed to decode recovery key for SSSS restore", { error: err.message });
    return fail;
  }

  // 5. Find SSSS key ID
  const defaultKey = await fetchAccountData<{ key: string }>(
    userId,
    "m.secret_storage.default_key",
  );
  if (!defaultKey?.key) {
    slog.warn("No SSSS default key found — cannot restore cross-signing");
    return fail;
  }
  const keyId = defaultKey.key;

  // 5b. Verify recovery key against SSSS key metadata
  const keyMeta = await fetchAccountData<KeyMetadata>(userId, `m.secret_storage.key.${keyId}`);
  if (keyMeta?.iv && keyMeta?.mac) {
    if (!verifyRecoveryKey(rawKey, keyMeta)) {
      slog.error("Recovery key does not match SSSS key — wrong key or corrupted metadata", {
        keyId,
      });
      return fail;
    }
    slog.info("Recovery key verified against SSSS key metadata", { keyId });
  } else {
    slog.warn("SSSS key metadata missing iv/mac — skipping key verification", { keyId });
  }

  // 6. Fetch and decrypt each cross-signing secret
  const restored: Array<{ name: string; value: string }> = [];

  for (const secretName of CROSS_SIGNING_SECRETS) {
    const accountData = await fetchAccountData<{
      encrypted?: Record<string, EncryptedData>;
    }>(userId, secretName);

    const encBlock = accountData?.encrypted?.[keyId];
    if (!encBlock) {
      slog.warn("SSSS: missing encrypted block for " + secretName, { keyId });
      return fail; // All three are required
    }

    try {
      const value = decryptSecret(rawKey, secretName, encBlock);
      restored.push({ name: secretName, value });
    } catch (err: any) {
      slog.error("SSSS decryption failed for " + secretName, { error: err.message });
      return fail;
    }
  }

  // 7. Insert into SQLite
  try {
    insertSecrets(storePath, restored);
    slog.info("Cross-signing keys restored from SSSS", { count: restored.length });
  } catch (err: any) {
    slog.error("Failed to insert cross-signing secrets into store", { error: err.message });
    return fail;
  }

  // 8. Return decrypted seeds keyed by role
  const secretsByName = new Map(restored.map((s) => [s.name, s.value]));
  return {
    restored: true,
    secrets: {
      master: secretsByName.get("m.cross_signing.master")!,
      selfSigning: secretsByName.get("m.cross_signing.self_signing")!,
      userSigning: secretsByName.get("m.cross_signing.user_signing")!,
    },
  };
}
