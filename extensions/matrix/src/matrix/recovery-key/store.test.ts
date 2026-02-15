/**
 * Unit tests for RecoveryKeyStore.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RECOVERY_KEY_TTL_MS } from "./constants.js";
import { RecoveryKeyStore } from "./store.js";

describe("RecoveryKeyStore", () => {
  let tempDir: string;
  let store: RecoveryKeyStore;

  beforeEach(async () => {
    // Create a temporary directory for test storage
    tempDir = path.join(os.tmpdir(), `recovery-key-store-test-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    store = new RecoveryKeyStore();
  });

  afterEach(async () => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("initialization", () => {
    it("should start with unverified state", () => {
      expect(store.isDeviceVerified()).toBe(false);
      expect(store.getDeviceId()).toBeNull();
      expect(store.getVerifiedAt()).toBeNull();
    });

    it("should initialize without storage directory", async () => {
      await store.initialize();
      expect(store.isDeviceVerified()).toBe(false);
    });

    it("should initialize with storage directory", async () => {
      await store.initialize(tempDir);
      expect(store.isDeviceVerified()).toBe(false);
    });

    it("should load persisted state from disk", async () => {
      // Create initial store and verify device
      const store1 = new RecoveryKeyStore();
      await store1.initialize(tempDir);
      await store1.setDeviceVerified(true, "DEVICE123");

      // Create new store instance and load
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isDeviceVerified()).toBe(true);
      expect(store2.getDeviceId()).toBe("DEVICE123");
      expect(store2.getVerifiedAt()).not.toBeNull();
    });
  });

  describe("device verification", () => {
    it("should mark device as verified", async () => {
      await store.initialize(tempDir);
      await store.setDeviceVerified(true, "DEVICE456");

      expect(store.isDeviceVerified()).toBe(true);
      expect(store.getDeviceId()).toBe("DEVICE456");
      expect(store.getVerifiedAt()).not.toBeNull();
    });

    it("should unmark device verification", async () => {
      await store.initialize(tempDir);
      await store.setDeviceVerified(true, "DEVICE789");
      await store.setDeviceVerified(false);

      expect(store.isDeviceVerified()).toBe(false);
      expect(store.getVerifiedAt()).toBeNull();
    });

    it("should persist verification state", async () => {
      await store.initialize(tempDir);
      await store.setDeviceVerified(true, "DEVICEABC");

      // Reload from disk
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isDeviceVerified()).toBe(true);
      expect(store2.getDeviceId()).toBe("DEVICEABC");
    });

    it("should store verification timestamp", async () => {
      await store.initialize(tempDir);
      const beforeTime = new Date().toISOString();
      await store.setDeviceVerified(true, "DEVICEXYZ");
      const afterTime = new Date().toISOString();

      const verifiedAt = store.getVerifiedAt();
      expect(verifiedAt).not.toBeNull();
      expect(verifiedAt! >= beforeTime).toBe(true);
      expect(verifiedAt! <= afterTime).toBe(true);
    });
  });

  describe("replay protection", () => {
    it("should mark recovery key as used", async () => {
      await store.initialize(tempDir);
      const keyHash = "hash123";

      await store.markRecoveryKeyUsed(keyHash);
      expect(store.isRecoveryKeyUsed(keyHash)).toBe(true);
    });

    it("should not mark different key as used", async () => {
      await store.initialize(tempDir);
      await store.markRecoveryKeyUsed("hash123");

      expect(store.isRecoveryKeyUsed("hash456")).toBe(false);
    });

    it("should persist used recovery keys", async () => {
      await store.initialize(tempDir);
      await store.markRecoveryKeyUsed("hashABC");

      // Reload from disk
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isRecoveryKeyUsed("hashABC")).toBe(true);
    });

    it("should detect expired keys (after TTL)", async () => {
      await store.initialize(tempDir);
      const keyHash = "hash789";

      // Mark as used
      await store.markRecoveryKeyUsed(keyHash);
      expect(store.isRecoveryKeyUsed(keyHash)).toBe(true);

      // Manually expire the key by modifying internal state
      const expiredTime = new Date(Date.now() - RECOVERY_KEY_TTL_MS - 1000).toISOString();
      // Access private field for testing (TypeScript allows this in tests)
      (store as any).usedRecoveryKeys[0].usedAt = expiredTime;

      expect(store.isRecoveryKeyUsed(keyHash)).toBe(false);
    });

    it("should keep keys within TTL window", async () => {
      await store.initialize(tempDir);
      const keyHash = "hashDEF";

      // Mark as used
      await store.markRecoveryKeyUsed(keyHash);

      // Set timestamp to just within TTL (23 hours ago)
      const recentTime = new Date(
        Date.now() - (RECOVERY_KEY_TTL_MS - 60 * 60 * 1000),
      ).toISOString();
      (store as any).usedRecoveryKeys[0].usedAt = recentTime;

      expect(store.isRecoveryKeyUsed(keyHash)).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("should remove expired recovery keys", async () => {
      await store.initialize(tempDir);

      // Add recent key
      await store.markRecoveryKeyUsed("recentKey");

      // Add expired key
      await store.markRecoveryKeyUsed("expiredKey");
      const expiredTime = new Date(Date.now() - RECOVERY_KEY_TTL_MS - 1000).toISOString();
      (store as any).usedRecoveryKeys[1].usedAt = expiredTime;

      // Cleanup
      store.cleanupExpiredKeys();

      expect(store.isRecoveryKeyUsed("recentKey")).toBe(true);
      expect(store.isRecoveryKeyUsed("expiredKey")).toBe(false);
    });

    it("should keep recent keys during cleanup", async () => {
      await store.initialize(tempDir);

      await store.markRecoveryKeyUsed("key1");
      await store.markRecoveryKeyUsed("key2");
      await store.markRecoveryKeyUsed("key3");

      store.cleanupExpiredKeys();

      expect(store.isRecoveryKeyUsed("key1")).toBe(true);
      expect(store.isRecoveryKeyUsed("key2")).toBe(true);
      expect(store.isRecoveryKeyUsed("key3")).toBe(true);
    });

    it("should automatically cleanup on persist", async () => {
      await store.initialize(tempDir);

      // Add expired key
      await store.markRecoveryKeyUsed("expiredKey");
      const expiredTime = new Date(Date.now() - RECOVERY_KEY_TTL_MS - 1000).toISOString();
      (store as any).usedRecoveryKeys[0].usedAt = expiredTime;

      // Trigger persist
      await store.setDeviceVerified(true, "DEVICE123");

      // Reload
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isRecoveryKeyUsed("expiredKey")).toBe(false);
    });

    it("should automatically cleanup on load", async () => {
      await store.initialize(tempDir);

      // Add expired key
      await store.markRecoveryKeyUsed("expiredKey");
      const expiredTime = new Date(Date.now() - RECOVERY_KEY_TTL_MS - 1000).toISOString();
      (store as any).usedRecoveryKeys[0].usedAt = expiredTime;

      // Force persist without cleanup
      await (store as any).savePersistedState();

      // Reload (should cleanup during load)
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isRecoveryKeyUsed("expiredKey")).toBe(false);
    });
  });

  describe("key backup metadata", () => {
    it("should store key backup version", async () => {
      await store.initialize(tempDir);
      await store.setKeyBackupInfo("v2", 100);

      expect(store.getKeyBackupVersion()).toBe("v2");
      expect(store.getRestoredSessionCount()).toBe(100);
    });

    it("should persist backup metadata", async () => {
      await store.initialize(tempDir);
      await store.setKeyBackupInfo("v3", 250);

      // Reload
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.getKeyBackupVersion()).toBe("v3");
      expect(store2.getRestoredSessionCount()).toBe(250);
    });

    it("should handle null backup version", async () => {
      await store.initialize(tempDir);
      await store.setKeyBackupInfo(null, 0);

      expect(store.getKeyBackupVersion()).toBeNull();
      expect(store.getRestoredSessionCount()).toBe(0);
    });
  });

  describe("concurrent access", () => {
    it("should handle concurrent writes with file locking", async () => {
      const store1 = new RecoveryKeyStore();
      const store2 = new RecoveryKeyStore();

      await store1.initialize(tempDir);
      await store2.initialize(tempDir);

      // Perform concurrent writes
      await Promise.all([
        store1.setDeviceVerified(true, "DEVICE1"),
        store2.markRecoveryKeyUsed("hash1"),
      ]);

      // Reload and verify both operations persisted
      const store3 = new RecoveryKeyStore();
      await store3.initialize(tempDir);

      // At least one of the writes should have persisted
      // (exact result depends on lock ordering, but no corruption should occur)
      expect(store3.isDeviceVerified() || store3.isRecoveryKeyUsed("hash1")).toBe(true);
    });

    it("should prevent file corruption during concurrent access", async () => {
      const stores = Array.from({ length: 5 }, () => new RecoveryKeyStore());

      // Initialize all stores
      await Promise.all(stores.map((s) => s.initialize(tempDir)));

      // Perform concurrent operations
      await Promise.all(stores.map((s, i) => s.markRecoveryKeyUsed(`hash${i}`)));

      // Reload and verify state file is valid JSON
      const finalStore = new RecoveryKeyStore();
      await finalStore.initialize(tempDir);

      // Should be able to check at least one key (no corruption)
      const hasAnyKey = stores.some((_, i) => finalStore.isRecoveryKeyUsed(`hash${i}`));
      expect(hasAnyKey).toBe(true);
    });
  });

  describe("persistence edge cases", () => {
    it("should handle missing storage directory gracefully", async () => {
      await store.initialize();
      await store.setDeviceVerified(true, "DEVICE123");

      // Should not throw, just skip persistence
      expect(store.isDeviceVerified()).toBe(true);
    });

    it("should create storage directory if missing", async () => {
      const newDir = path.join(tempDir, "nested", "path");
      await store.initialize(newDir);
      await store.setDeviceVerified(true, "DEVICE456");

      expect(fs.existsSync(newDir)).toBe(true);
    });

    it("should handle corrupted state file", async () => {
      await store.initialize(tempDir);
      const statePath = path.join(tempDir, "recovery-key-verification-state.json");

      // Write corrupted JSON
      await fs.promises.writeFile(statePath, "{ invalid json", "utf8");

      // Should load defaults without throwing
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isDeviceVerified()).toBe(false);
    });

    it("should handle missing state file fields", async () => {
      await store.initialize(tempDir);
      const statePath = path.join(tempDir, "recovery-key-verification-state.json");

      // Write partial state
      await fs.promises.writeFile(statePath, JSON.stringify({ deviceVerified: true }), "utf8");

      // Should load with defaults for missing fields
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isDeviceVerified()).toBe(true);
      expect(store2.getDeviceId()).toBeNull();
      expect(store2.getKeyBackupVersion()).toBeNull();
    });
  });

  describe("full workflow", () => {
    it("should handle complete verification workflow", async () => {
      await store.initialize(tempDir);

      // Step 1: Mark recovery key as used
      const keyHash = "recoveryKeyHash123";
      await store.markRecoveryKeyUsed(keyHash);
      expect(store.isRecoveryKeyUsed(keyHash)).toBe(true);

      // Step 2: Verify device
      await store.setDeviceVerified(true, "DEVICE_FULL_WORKFLOW");
      expect(store.isDeviceVerified()).toBe(true);

      // Step 3: Set backup info
      await store.setKeyBackupInfo("v5", 500);
      expect(store.getKeyBackupVersion()).toBe("v5");
      expect(store.getRestoredSessionCount()).toBe(500);

      // Step 4: Reload and verify all state persisted
      const store2 = new RecoveryKeyStore();
      await store2.initialize(tempDir);

      expect(store2.isRecoveryKeyUsed(keyHash)).toBe(true);
      expect(store2.isDeviceVerified()).toBe(true);
      expect(store2.getDeviceId()).toBe("DEVICE_FULL_WORKFLOW");
      expect(store2.getKeyBackupVersion()).toBe("v5");
      expect(store2.getRestoredSessionCount()).toBe(500);
    });
  });
});
