import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

export type EncryptedPayload = {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
};

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns base64-encoded ciphertext, IV, and authentication tag.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  if (key.length !== 32) {
    throw new Error(`encryption key must be exactly 32 bytes (got ${key.length})`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Throws if the key is wrong, data is tampered, or tag is invalid.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  if (key.length !== 32) {
    throw new Error(`encryption key must be exactly 32 bytes (got ${key.length})`);
  }
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Parse the AUTH_ENCRYPTION_KEY env var into a 32-byte Buffer.
 * Accepts hex (64 chars) or base64 (44 chars).
 * Returns null if the env var is not set or invalid.
 */
export function parseEncryptionKey(envValue?: string): Buffer | null {
  if (!envValue || !envValue.trim()) {
    return null;
  }
  const trimmed = envValue.trim();

  // Hex: 64 hex chars = 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // Base64: try to decode and check length
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // not valid base64
  }

  return null;
}

/**
 * Encrypt a JSON-serializable value.
 */
export function encryptJson(value: unknown, key: Buffer): EncryptedPayload {
  return encrypt(JSON.stringify(value), key);
}

/**
 * Decrypt and parse a JSON payload.
 */
export function decryptJson<T = unknown>(payload: EncryptedPayload, key: Buffer): T {
  const plaintext = decrypt(payload, key);
  return JSON.parse(plaintext) as T;
}
