/**
 * AES-256-GCM encryption for persisted auth profile secrets.
 *
 * When OPENCLAW_AUTH_PROFILE_SECRET_KEY is set, store_json payloads are
 * encrypted before writing to SQLite and decrypted after reading. Without the
 * key, storage is plaintext (backward-compatible with existing databases).
 */
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ENV = "OPENCLAW_AUTH_PROFILE_SECRET_KEY";

function deriveKey(secret: string): Buffer {
  return crypto.hash("sha256", `openclaw:auth-profile-store:${secret}`, "buffer");
}

let cachedKey: Buffer | null | undefined;

function resolveEncryptionKey(): Buffer | null {
  if (cachedKey !== undefined) {
    return cachedKey;
  }
  const envKey = process.env[KEY_ENV];
  if (envKey && envKey.trim()) {
    cachedKey = deriveKey(envKey.trim());
  } else {
    cachedKey = null;
  }
  return cachedKey;
}

/** Clears the cached encryption key so the next call re-reads the env var. */
export function clearAuthProfileEncryptionKeyCache(): void {
  cachedKey = undefined;
}

type EncryptedEnvelope = { encrypted: string };

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "encrypted" in value &&
    typeof (value as EncryptedEnvelope).encrypted === "string"
  );
}

/**
 * Encrypts a JSON-serialisable payload. Returns the encrypted envelope or
 * null when no key is configured (plaintext fallback).
 */
export function encryptAuthProfilePayload(payload: unknown): EncryptedEnvelope | null {
  const key = resolveEncryptionKey();
  if (!key) {
    return null;
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([iv, encrypted, tag]).toString("base64url"),
  };
}

/**
 * Decrypts an encrypted envelope. Returns null on failure or when no key is
 * configured.
 */
export function decryptAuthProfilePayload(envelope: EncryptedEnvelope): unknown | null {
  const key = resolveEncryptionKey();
  if (!key) {
    return null;
  }
  try {
    const buf = Buffer.from(envelope.encrypted, "base64url");
    if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
      return null;
    }
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(buf.length - TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Reads a possibly-encrypted raw store_json value. If the parsed JSON is an
 * encrypted envelope and a key is configured, decrypts it. Otherwise returns
 * the JSON as-is (plaintext backward compat).
 */
export function decryptAuthProfileStoreRaw(raw: unknown): unknown {
  if (!isEncryptedEnvelope(raw)) {
    return raw;
  }
  return decryptAuthProfilePayload(raw) ?? raw;
}
