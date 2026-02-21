import * as crypto from "node:crypto";

/**
 * Encrypted private key storage format
 * Uses AES-256-GCM for authenticated encryption
 */
export interface EncryptedPrivateKey {
  /** Algorithm identifier for decryption logic */
  algorithm: "aes-256-gcm";
  /** Base64-encoded IV (initialization vector) */
  iv: string;
  /** Base64-encoded authentication tag */
  authTag: string;
  /** Base64-encoded ciphertext (encrypted private key) */
  ciphertext: string;
  /** PBKDF2 salt used for key derivation (base64-encoded) */
  salt: string;
}

/**
 * Derive an encryption key from a passphrase using PBKDF2
 * @param passphrase - The passphrase/password to derive from
 * @param salt - Salt for key derivation (generated if not provided)
 * @returns Tuple of [derived key (32 bytes), salt used]
 */
export function deriveKeyFromPassphrase(passphrase: string, salt?: Buffer): [Buffer, Buffer] {
  const actualSalt = salt || crypto.randomBytes(32);

  // PBKDF2: derive 32 bytes (256 bits) for AES-256
  const derivedKey = crypto.pbkdf2Sync(passphrase, actualSalt, 100_000, 32, "sha256");

  return [derivedKey, actualSalt];
}

/**
 * Encrypt a private key (hex string) using AES-256-GCM
 * @param privateKeyHex - Private key in hex format (64 characters)
 * @param passphrase - Passphrase/password for encryption
 * @returns Encrypted private key object
 */
export function encryptPrivateKey(privateKeyHex: string, passphrase: string): EncryptedPrivateKey {
  // Validate private key format
  const trimmed = privateKeyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Private key must be 64 hex characters");
  }

  // Derive encryption key from passphrase
  const [derivedKey, salt] = deriveKeyFromPassphrase(passphrase);

  // Generate random IV (96 bits is standard for GCM)
  const iv = crypto.randomBytes(12);

  // Create cipher
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);

  // Encrypt the private key
  let ciphertext = cipher.update(trimmed, "utf-8", "binary");
  ciphertext += cipher.final("binary");

  // Get authentication tag
  const authTag = cipher.getAuthTag();

  return {
    algorithm: "aes-256-gcm",
    iv: Buffer.from(iv).toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: Buffer.from(ciphertext, "binary").toString("base64"),
    salt: salt.toString("base64"),
  };
}

/**
 * Decrypt a private key using AES-256-GCM
 * @param encrypted - Encrypted private key object
 * @param passphrase - Passphrase/password for decryption
 * @returns Decrypted private key in hex format
 */
export function decryptPrivateKey(encrypted: EncryptedPrivateKey, passphrase: string): string {
  // Validate algorithm
  if (encrypted.algorithm !== "aes-256-gcm") {
    throw new Error(`Unsupported encryption algorithm: ${encrypted.algorithm}`);
  }

  // Decode components from base64
  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const salt = Buffer.from(encrypted.salt, "base64");

  // Derive the same key using the stored salt and passphrase
  const [derivedKey] = deriveKeyFromPassphrase(passphrase, salt);

  // Create decipher
  const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);

  // Set the authentication tag for verification
  decipher.setAuthTag(authTag);

  // Decrypt
  let plaintext = decipher.update(ciphertext, "binary", "utf-8");
  plaintext += decipher.final("utf-8");

  // Validate decrypted key format
  if (!/^[0-9a-fA-F]{64}$/.test(plaintext)) {
    throw new Error("Decryption failed: invalid private key format");
  }

  return plaintext;
}

/**
 * Validate that an encrypted private key object has all required fields
 */
export function isValidEncryptedPrivateKey(obj: unknown): obj is EncryptedPrivateKey {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const encrypted = obj as Record<string, unknown>;

  return (
    encrypted.algorithm === "aes-256-gcm" &&
    typeof encrypted.iv === "string" &&
    typeof encrypted.authTag === "string" &&
    typeof encrypted.ciphertext === "string" &&
    typeof encrypted.salt === "string"
  );
}
