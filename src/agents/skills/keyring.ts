/**
 * Keyring management for skill signature verification.
 *
 * The keyring stores trusted public keys that can be used to verify
 * skill signatures. Keys are stored in ~/.openclaw/keyring.json with
 * private keys in ~/.openclaw/keys/.
 */

import fs from "node:fs";
import path from "node:path";

import { CONFIG_DIR } from "../../utils.js";

import { computeFingerprint } from "./crypto.js";
import type { Keyring, TrustedKey, SignerRole, KeyTrustLevel } from "./types.signature.js";

const KEYRING_PATH = path.join(CONFIG_DIR, "keyring.json");
const PRIVATE_KEYS_DIR = path.join(CONFIG_DIR, "keys");

/**
 * Load the keyring from disk.
 * Returns an empty keyring if the file doesn't exist or is invalid.
 */
export function loadKeyring(): Keyring {
  try {
    if (!fs.existsSync(KEYRING_PATH)) {
      return { version: 1, keys: [] };
    }
    const content = fs.readFileSync(KEYRING_PATH, "utf-8");
    const parsed = JSON.parse(content) as Keyring;
    // Basic validation
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      return { version: 1, keys: [] };
    }
    return parsed;
  } catch {
    return { version: 1, keys: [] };
  }
}

/**
 * Save the keyring to disk with secure permissions.
 */
export function saveKeyring(keyring: Keyring): void {
  const dir = path.dirname(KEYRING_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(KEYRING_PATH, JSON.stringify(keyring, null, 2), { mode: 0o600 });
}

/**
 * Parameters for adding a trusted key.
 */
export type AddTrustedKeyParams = {
  publicKey: string;
  name: string;
  trust: KeyTrustLevel;
  trusted_roles: SignerRole[];
  notes?: string;
  expires_at?: string;
};

/**
 * Add a trusted key to the keyring.
 * Throws if the key already exists.
 */
export function addTrustedKey(params: AddTrustedKeyParams): TrustedKey {
  const keyring = loadKeyring();
  const fingerprint = computeFingerprint(params.publicKey);

  // Check for duplicate
  const existing = keyring.keys.find((k) => k.fingerprint === fingerprint);
  if (existing) {
    throw new Error(`Key ${fingerprint} already in keyring as "${existing.name}"`);
  }

  const entry: TrustedKey = {
    fingerprint,
    public_key: params.publicKey,
    name: params.name,
    trust: params.trust,
    trusted_roles: params.trusted_roles,
    added_at: new Date().toISOString(),
    expires_at: params.expires_at,
    notes: params.notes,
  };

  keyring.keys.push(entry);
  saveKeyring(keyring);

  return entry;
}

/**
 * Update an existing key in the keyring.
 */
export function updateTrustedKey(
  fingerprint: string,
  updates: Partial<Pick<TrustedKey, "name" | "trust" | "trusted_roles" | "notes" | "expires_at">>,
): TrustedKey | undefined {
  const keyring = loadKeyring();
  const key = keyring.keys.find((k) => k.fingerprint === fingerprint);
  if (!key) return undefined;

  if (updates.name !== undefined) key.name = updates.name;
  if (updates.trust !== undefined) key.trust = updates.trust;
  if (updates.trusted_roles !== undefined) key.trusted_roles = updates.trusted_roles;
  if (updates.notes !== undefined) key.notes = updates.notes;
  if (updates.expires_at !== undefined) key.expires_at = updates.expires_at;

  saveKeyring(keyring);
  return key;
}

/**
 * Remove a key from the keyring.
 * Returns true if the key was found and removed.
 */
export function removeTrustedKey(fingerprint: string): boolean {
  const keyring = loadKeyring();
  const index = keyring.keys.findIndex((k) => k.fingerprint === fingerprint);
  if (index === -1) return false;

  keyring.keys.splice(index, 1);
  saveKeyring(keyring);
  return true;
}

/**
 * Find a key by fingerprint.
 */
export function findKey(fingerprint: string): TrustedKey | undefined {
  const keyring = loadKeyring();
  return keyring.keys.find((k) => k.fingerprint === fingerprint);
}

/**
 * Find a key by name (case-insensitive partial match).
 */
export function findKeyByName(name: string): TrustedKey | undefined {
  const keyring = loadKeyring();
  const lowerName = name.toLowerCase();
  return keyring.keys.find((k) => k.name.toLowerCase().includes(lowerName));
}

/**
 * Result of checking key trust for a role.
 */
export type KeyTrustCheckResult = {
  trusted: boolean;
  key?: TrustedKey;
  reason?: string;
};

/**
 * Check if a key is trusted for a given role.
 */
export function isKeyTrustedForRole(fingerprint: string, role: SignerRole): KeyTrustCheckResult {
  const key = findKey(fingerprint);

  if (!key) {
    return { trusted: false, reason: "Key not in keyring" };
  }

  if (key.trust === "none") {
    return { trusted: false, key, reason: "Key trust level is 'none'" };
  }

  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    return { trusted: false, key, reason: "Key has expired" };
  }

  if (!key.trusted_roles.includes(role)) {
    return {
      trusted: false,
      key,
      reason: `Key not trusted for role '${role}'`,
    };
  }

  return { trusted: true, key };
}

/**
 * List all keys in the keyring.
 */
export function listKeys(): TrustedKey[] {
  return loadKeyring().keys;
}

/**
 * Save a private key to the keys directory with secure permissions.
 * Returns the path where the key was saved.
 */
export function savePrivateKey(
  fingerprint: string,
  privateKeyBase64: string,
  name: string,
): string {
  if (!fs.existsSync(PRIVATE_KEYS_DIR)) {
    fs.mkdirSync(PRIVATE_KEYS_DIR, { recursive: true, mode: 0o700 });
  }

  // Sanitize name for filename
  const safeName = name.replace(/[^a-z0-9_-]/gi, "_");
  const safeFingerprint = fingerprint.replace(/:/g, "");
  const filename = `${safeName}_${safeFingerprint}.key`;
  const keyPath = path.join(PRIVATE_KEYS_DIR, filename);

  fs.writeFileSync(keyPath, privateKeyBase64, { mode: 0o600 });

  return keyPath;
}

/**
 * Load a private key from file.
 */
export function loadPrivateKey(keyPath: string): string {
  return fs.readFileSync(keyPath, "utf-8").trim();
}

/**
 * List all private key files in the keys directory.
 */
export function listPrivateKeyFiles(): string[] {
  if (!fs.existsSync(PRIVATE_KEYS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(PRIVATE_KEYS_DIR)
    .filter((f) => f.endsWith(".key"))
    .map((f) => path.join(PRIVATE_KEYS_DIR, f));
}

/**
 * Delete a private key file.
 */
export function deletePrivateKey(keyPath: string): boolean {
  try {
    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Well-known keys that can be imported.
 * These are official or community-trusted keys.
 */
const WELL_KNOWN_KEYS: Array<Omit<TrustedKey, "added_at">> = [
  // OpenClaw official signing key (placeholder - real key to be added later)
  {
    fingerprint: "oc:la:w0:ff:1c:1a:l0:00",
    public_key: "PLACEHOLDER_OPENCLAW_OFFICIAL_KEY",
    name: "OpenClaw Official",
    trust: "full",
    trusted_roles: ["author", "auditor"],
    notes: "Official OpenClaw project signing key",
  },
];

/**
 * Import well-known keys into the keyring.
 * Returns the number of keys imported (skips existing ones).
 */
export function importWellKnownKeys(): number {
  let imported = 0;
  const keyring = loadKeyring();

  for (const key of WELL_KNOWN_KEYS) {
    const exists = keyring.keys.some((k) => k.fingerprint === key.fingerprint);
    if (!exists) {
      keyring.keys.push({
        ...key,
        added_at: new Date().toISOString(),
      });
      imported++;
    }
  }

  if (imported > 0) {
    saveKeyring(keyring);
  }

  return imported;
}

/**
 * Clear the entire keyring (for testing purposes).
 */
export function clearKeyring(): void {
  saveKeyring({ version: 1, keys: [] });
}

/**
 * Get the path to the keyring file.
 */
export function getKeyringPath(): string {
  return KEYRING_PATH;
}

/**
 * Get the path to the private keys directory.
 */
export function getPrivateKeysDir(): string {
  return PRIVATE_KEYS_DIR;
}
