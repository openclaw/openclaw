import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateKeypair } from "./crypto.js";
import {
  addTrustedKey,
  clearKeyring,
  deletePrivateKey,
  findKey,
  findKeyByName,
  getKeyringPath,
  getPrivateKeysDir,
  importWellKnownKeys,
  isKeyTrustedForRole,
  listKeys,
  listPrivateKeyFiles,
  loadKeyring,
  loadPrivateKey,
  removeTrustedKey,
  saveKeyring,
  savePrivateKey,
  updateTrustedKey,
} from "./keyring.js";
import type { Keyring } from "./types.signature.js";

// Use a test-specific keyring path
const TEST_KEYRING_DIR = path.join(process.cwd(), ".test-keyring");
const TEST_KEYRING_PATH = path.join(TEST_KEYRING_DIR, "keyring.json");
const TEST_KEYS_DIR = path.join(TEST_KEYRING_DIR, "keys");

// Mock the paths
vi.mock("../../utils.js", () => ({
  CONFIG_DIR: path.join(process.cwd(), ".test-keyring"),
}));

describe("keyring", () => {
  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_KEYRING_DIR)) {
      fs.rmSync(TEST_KEYRING_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_KEYRING_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_KEYRING_DIR)) {
      fs.rmSync(TEST_KEYRING_DIR, { recursive: true });
    }
  });

  describe("loadKeyring", () => {
    it("returns empty keyring when file does not exist", () => {
      const keyring = loadKeyring();
      expect(keyring.version).toBe(1);
      expect(keyring.keys).toEqual([]);
    });

    it("loads existing keyring from disk", () => {
      const testKeyring: Keyring = {
        version: 1,
        keys: [
          {
            fingerprint: "ab:cd:ef:12:34:56:78:90",
            public_key: "test-key",
            name: "Test Key",
            trust: "full",
            trusted_roles: ["author"],
            added_at: "2026-01-01T00:00:00Z",
          },
        ],
      };
      fs.writeFileSync(TEST_KEYRING_PATH, JSON.stringify(testKeyring));

      const keyring = loadKeyring();
      expect(keyring.keys).toHaveLength(1);
      expect(keyring.keys[0].name).toBe("Test Key");
    });

    it("returns empty keyring for invalid JSON", () => {
      fs.writeFileSync(TEST_KEYRING_PATH, "not valid json");
      const keyring = loadKeyring();
      expect(keyring.keys).toEqual([]);
    });

    it("returns empty keyring for invalid structure", () => {
      fs.writeFileSync(TEST_KEYRING_PATH, JSON.stringify({ version: 2 }));
      const keyring = loadKeyring();
      expect(keyring.keys).toEqual([]);
    });
  });

  describe("saveKeyring", () => {
    it("creates directory and saves keyring", () => {
      const keyring: Keyring = { version: 1, keys: [] };
      saveKeyring(keyring);

      expect(fs.existsSync(TEST_KEYRING_PATH)).toBe(true);
      const content = JSON.parse(fs.readFileSync(TEST_KEYRING_PATH, "utf-8"));
      expect(content.version).toBe(1);
    });

    it("saves keyring with correct permissions", () => {
      const keyring: Keyring = { version: 1, keys: [] };
      saveKeyring(keyring);

      const stats = fs.statSync(TEST_KEYRING_PATH);
      // Check owner read/write only (0o600 = 384 decimal, but may vary by umask)
      expect(stats.mode & 0o777).toBeLessThanOrEqual(0o600);
    });
  });

  describe("addTrustedKey", () => {
    it("adds a new key to the keyring", async () => {
      const keypair = await generateKeypair();

      const entry = addTrustedKey({
        publicKey: keypair.publicKey,
        name: "My Key",
        trust: "full",
        trusted_roles: ["author", "auditor"],
        notes: "Test key",
      });

      expect(entry.fingerprint).toBe(keypair.fingerprint);
      expect(entry.name).toBe("My Key");
      expect(entry.trust).toBe("full");
      expect(entry.trusted_roles).toEqual(["author", "auditor"]);
      expect(entry.added_at).toBeTruthy();

      // Verify persisted
      const keyring = loadKeyring();
      expect(keyring.keys).toHaveLength(1);
    });

    it("throws on duplicate key", async () => {
      const keypair = await generateKeypair();

      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "First",
        trust: "full",
        trusted_roles: ["author"],
      });

      expect(() =>
        addTrustedKey({
          publicKey: keypair.publicKey,
          name: "Second",
          trust: "full",
          trusted_roles: ["author"],
        }),
      ).toThrow(/already in keyring/);
    });

    it("supports expiration date", async () => {
      const keypair = await generateKeypair();
      const expiresAt = "2027-01-01T00:00:00Z";

      const entry = addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Expiring Key",
        trust: "full",
        trusted_roles: ["author"],
        expires_at: expiresAt,
      });

      expect(entry.expires_at).toBe(expiresAt);
    });
  });

  describe("updateTrustedKey", () => {
    it("updates existing key properties", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Original Name",
        trust: "marginal",
        trusted_roles: ["author"],
      });

      const updated = updateTrustedKey(keypair.fingerprint, {
        name: "Updated Name",
        trust: "full",
        trusted_roles: ["author", "auditor"],
        notes: "Now trusted",
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe("Updated Name");
      expect(updated?.trust).toBe("full");
      expect(updated?.trusted_roles).toEqual(["author", "auditor"]);
      expect(updated?.notes).toBe("Now trusted");
    });

    it("returns undefined for non-existent key", () => {
      const result = updateTrustedKey("no:ex:is:te:nt:ke:y0:00", { name: "New Name" });
      expect(result).toBeUndefined();
    });
  });

  describe("removeTrustedKey", () => {
    it("removes existing key", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "To Remove",
        trust: "full",
        trusted_roles: ["author"],
      });

      const removed = removeTrustedKey(keypair.fingerprint);
      expect(removed).toBe(true);

      const keyring = loadKeyring();
      expect(keyring.keys).toHaveLength(0);
    });

    it("returns false for non-existent key", () => {
      const removed = removeTrustedKey("no:ex:is:te:nt:ke:y0:00");
      expect(removed).toBe(false);
    });
  });

  describe("findKey", () => {
    it("finds key by fingerprint", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Findable Key",
        trust: "full",
        trusted_roles: ["author"],
      });

      const found = findKey(keypair.fingerprint);
      expect(found).toBeDefined();
      expect(found?.name).toBe("Findable Key");
    });

    it("returns undefined for non-existent key", () => {
      const found = findKey("no:ex:is:te:nt:ke:y0:00");
      expect(found).toBeUndefined();
    });
  });

  describe("findKeyByName", () => {
    it("finds key by partial name match", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Alice's Signing Key",
        trust: "full",
        trusted_roles: ["author"],
      });

      const found = findKeyByName("alice");
      expect(found).toBeDefined();
      expect(found?.name).toBe("Alice's Signing Key");
    });

    it("is case-insensitive", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "BOB",
        trust: "full",
        trusted_roles: ["author"],
      });

      const found = findKeyByName("bob");
      expect(found).toBeDefined();
    });
  });

  describe("isKeyTrustedForRole", () => {
    it("returns trusted for valid key and role", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Author Key",
        trust: "full",
        trusted_roles: ["author"],
      });

      const result = isKeyTrustedForRole(keypair.fingerprint, "author");
      expect(result.trusted).toBe(true);
      expect(result.key).toBeDefined();
    });

    it("returns not trusted for missing key", () => {
      const result = isKeyTrustedForRole("no:ex:is:te:nt:ke:y0:00", "author");
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe("Key not in keyring");
    });

    it("returns not trusted for trust level none", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Blocked Key",
        trust: "none",
        trusted_roles: ["author"],
      });

      const result = isKeyTrustedForRole(keypair.fingerprint, "author");
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe("Key trust level is 'none'");
    });

    it("returns not trusted for expired key", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Expired Key",
        trust: "full",
        trusted_roles: ["author"],
        expires_at: "2020-01-01T00:00:00Z", // Past date
      });

      const result = isKeyTrustedForRole(keypair.fingerprint, "author");
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe("Key has expired");
    });

    it("returns not trusted for wrong role", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "Author Only Key",
        trust: "full",
        trusted_roles: ["author"],
      });

      const result = isKeyTrustedForRole(keypair.fingerprint, "auditor");
      expect(result.trusted).toBe(false);
      expect(result.reason).toBe("Key not trusted for role 'auditor'");
    });
  });

  describe("listKeys", () => {
    it("returns all keys", async () => {
      const keypair1 = await generateKeypair();
      const keypair2 = await generateKeypair();

      addTrustedKey({
        publicKey: keypair1.publicKey,
        name: "Key 1",
        trust: "full",
        trusted_roles: ["author"],
      });
      addTrustedKey({
        publicKey: keypair2.publicKey,
        name: "Key 2",
        trust: "marginal",
        trusted_roles: ["voucher"],
      });

      const keys = listKeys();
      expect(keys).toHaveLength(2);
    });

    it("returns empty array when no keys", () => {
      const keys = listKeys();
      expect(keys).toEqual([]);
    });
  });

  describe("private key management", () => {
    it("saves and loads private key", async () => {
      const keypair = await generateKeypair();

      const keyPath = savePrivateKey(keypair.fingerprint, keypair.privateKey, "Test Key");

      expect(fs.existsSync(keyPath)).toBe(true);

      const loaded = loadPrivateKey(keyPath);
      expect(loaded).toBe(keypair.privateKey);
    });

    it("saves with secure permissions", async () => {
      const keypair = await generateKeypair();
      const keyPath = savePrivateKey(keypair.fingerprint, keypair.privateKey, "Secure Key");

      const stats = fs.statSync(keyPath);
      expect(stats.mode & 0o777).toBeLessThanOrEqual(0o600);
    });

    it("sanitizes filename", async () => {
      const keypair = await generateKeypair();
      const keyPath = savePrivateKey(
        keypair.fingerprint,
        keypair.privateKey,
        "Unsafe/Name With Spaces!",
      );

      expect(keyPath).toContain("Unsafe_Name_With_Spaces_");
      expect(fs.existsSync(keyPath)).toBe(true);
    });

    it("lists private key files", async () => {
      const keypair1 = await generateKeypair();
      const keypair2 = await generateKeypair();

      savePrivateKey(keypair1.fingerprint, keypair1.privateKey, "Key1");
      savePrivateKey(keypair2.fingerprint, keypair2.privateKey, "Key2");

      const files = listPrivateKeyFiles();
      expect(files).toHaveLength(2);
    });

    it("deletes private key", async () => {
      const keypair = await generateKeypair();
      const keyPath = savePrivateKey(keypair.fingerprint, keypair.privateKey, "ToDelete");

      expect(fs.existsSync(keyPath)).toBe(true);

      const deleted = deletePrivateKey(keyPath);
      expect(deleted).toBe(true);
      expect(fs.existsSync(keyPath)).toBe(false);
    });

    it("returns false when deleting non-existent key", () => {
      const deleted = deletePrivateKey("/non/existent/path.key");
      expect(deleted).toBe(false);
    });
  });

  describe("importWellKnownKeys", () => {
    it("imports well-known keys", () => {
      const imported = importWellKnownKeys();
      expect(imported).toBeGreaterThan(0);

      const keys = listKeys();
      expect(keys.some((k) => k.name === "OpenClaw Official")).toBe(true);
    });

    it("skips already imported keys", () => {
      importWellKnownKeys();
      const secondImport = importWellKnownKeys();
      expect(secondImport).toBe(0);
    });
  });

  describe("clearKeyring", () => {
    it("removes all keys", async () => {
      const keypair = await generateKeypair();
      addTrustedKey({
        publicKey: keypair.publicKey,
        name: "To Clear",
        trust: "full",
        trusted_roles: ["author"],
      });

      expect(listKeys()).toHaveLength(1);

      clearKeyring();

      expect(listKeys()).toHaveLength(0);
    });
  });

  describe("path getters", () => {
    it("returns keyring path", () => {
      const keyringPath = getKeyringPath();
      expect(keyringPath).toContain("keyring.json");
    });

    it("returns private keys directory", () => {
      const keysDir = getPrivateKeysDir();
      expect(keysDir).toContain("keys");
    });
  });
});
