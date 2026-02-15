/**
 * End-to-end integration tests for multi-account device verification.
 *
 * These tests verify that multiple Matrix accounts can be verified independently,
 * with proper state isolation and account-specific operations.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import crypto from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RecoveryKeyStore as VerificationStore } from "./store.js";
import { BASE58_ALPHABET } from "./constants.js";
import { RecoveryKeyHandler } from "./handler.js";
import {
  registerMatrixRecoveryKeyHandler,
  getMatrixRecoveryKeyHandler,
  getMatrixVerificationStore,
  unregisterMatrixRecoveryKeyHandler,
  listRegisteredAccounts,
} from "./registry.js";

/**
 * Generate a valid Base58-encoded recovery key for testing.
 */
function generateValidRecoveryKey(): { raw: Uint8Array; encoded: string } {
  const keyBytes = crypto.randomBytes(32);

  // Build full 35-byte recovery key format per MSC1946
  const fullBytes = new Uint8Array(35);
  fullBytes[0] = 0x8b; // Prefix byte 1
  fullBytes[1] = 0x01; // Prefix byte 2
  fullBytes.set(keyBytes, 2); // 32-byte key at bytes 2-33

  // Calculate parity byte (XOR of first 34 bytes)
  let parity = 0;
  for (let i = 0; i < 34; i++) {
    parity ^= fullBytes[i];
  }
  fullBytes[34] = parity; // Parity at byte 34

  // Base58 encode
  let value = BigInt(0);
  for (const byte of fullBytes) {
    value = value * BigInt(256) + BigInt(byte);
  }

  let encoded = "";
  while (value > BigInt(0)) {
    const remainder = Number(value % BigInt(58));
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value = value / BigInt(58);
  }

  // Handle leading zeros (each zero byte becomes '1' in Base58)
  for (const byte of fullBytes) {
    if (byte !== 0) break;
    encoded = BASE58_ALPHABET[0] + encoded;
  }

  return { raw: keyBytes, encoded };
}

/**
 * Create a mock Matrix client for testing.
 */
function createMockClient(userId: string, deviceId: string): MatrixClient {
  return {
    userId,
    getUserId: vi.fn().mockResolvedValue(userId),
    crypto: {
      deviceId,
      deviceEd25519: `${deviceId}_ed25519`,
      deviceCurve25519: `${deviceId}_curve25519`,
    },
    doRequest: vi.fn().mockRejectedValue(new Error("Network error")),
  } as unknown as MatrixClient;
}

/**
 * Create a mock verification store for testing.
 */
function createMockStore(): VerificationStore {
  return {
    isRecoveryKeyUsed: vi.fn().mockReturnValue(false),
    markRecoveryKeyUsed: vi.fn(),
    setDeviceVerified: vi.fn(),
    setKeyBackupInfo: vi.fn(),
  } as unknown as VerificationStore;
}

describe("Multi-Account E2E Integration", () => {
  beforeEach(() => {
    // Clear registry before each test
    for (const accountId of listRegisteredAccounts()) {
      unregisterMatrixRecoveryKeyHandler(accountId);
    }
  });

  describe("Two-Account Configuration and Verification", () => {
    it("should register and retrieve handlers for two independent accounts", () => {
      // Arrange: Create two account configurations
      const personalClient = createMockClient("@user:example.com", "DEVICE_PERSONAL");
      const workClient = createMockClient("@user:work.com", "DEVICE_WORK");

      const personalStore = createMockStore();
      const workStore = createMockStore();

      const personalHandler = new RecoveryKeyHandler(personalClient, personalStore);
      const workHandler = new RecoveryKeyHandler(workClient, workStore);

      // Act: Register both handlers
      registerMatrixRecoveryKeyHandler(personalHandler, "personal");
      registerMatrixRecoveryKeyHandler(workHandler, "work");

      // Assert: Both accounts should be registered
      const accounts = listRegisteredAccounts();
      expect(accounts).toHaveLength(2);
      expect(accounts).toContain("personal");
      expect(accounts).toContain("work");

      // Verify handlers are retrievable
      expect(getMatrixRecoveryKeyHandler("personal")).toBe(personalHandler);
      expect(getMatrixRecoveryKeyHandler("work")).toBe(workHandler);

      // Verify stores are retrievable
      expect(getMatrixVerificationStore("personal")).toBe(personalStore);
      expect(getMatrixVerificationStore("work")).toBe(workStore);
    });

    it("should maintain independent verification states for each account", async () => {
      // Arrange: Two accounts with separate handlers
      const personalClient = createMockClient("@user:example.com", "DEVICE_PERSONAL");
      const workClient = createMockClient("@user:work.com", "DEVICE_WORK");

      const personalStore = createMockStore();
      const workStore = createMockStore();

      const personalHandler = new RecoveryKeyHandler(personalClient, personalStore);
      const workHandler = new RecoveryKeyHandler(workClient, workStore);

      registerMatrixRecoveryKeyHandler(personalHandler, "personal");
      registerMatrixRecoveryKeyHandler(workHandler, "work");

      // Generate recovery keys
      const { encoded: personalKey } = generateValidRecoveryKey();
      const { encoded: workKey } = generateValidRecoveryKey();

      // Act: Attempt verification on both accounts
      const personalResult = await personalHandler.verifyWithRecoveryKey(personalKey);
      const workResult = await workHandler.verifyWithRecoveryKey(workKey);

      // Assert: Both operations should proceed independently
      expect(personalStore.isRecoveryKeyUsed).toHaveBeenCalled();
      expect(workStore.isRecoveryKeyUsed).toHaveBeenCalled();

      // Results should be independent (both will fail due to network mock)
      expect(personalResult.success).toBe(false);
      expect(workResult.success).toBe(false);
    });

    it("should allow same recovery key to be used across different accounts", async () => {
      // Arrange: Two accounts, same recovery key, but independent replay protection
      const personalClient = createMockClient("@user:example.com", "DEVICE_PERSONAL");
      const workClient = createMockClient("@user:work.com", "DEVICE_WORK");

      const personalStore = createMockStore();
      const workStore = createMockStore();

      const personalHandler = new RecoveryKeyHandler(personalClient, personalStore);
      const workHandler = new RecoveryKeyHandler(workClient, workStore);

      registerMatrixRecoveryKeyHandler(personalHandler, "personal");
      registerMatrixRecoveryKeyHandler(workHandler, "work");

      // Use the SAME recovery key for both accounts
      const { encoded: sharedKey } = generateValidRecoveryKey();

      // Act: Use same key on both accounts
      const personalResult = await personalHandler.verifyWithRecoveryKey(sharedKey);
      const workResult = await workHandler.verifyWithRecoveryKey(sharedKey);

      // Assert: Both should proceed past replay check (each account has independent replay tracking)
      expect(personalStore.isRecoveryKeyUsed).toHaveBeenCalled();
      expect(workStore.isRecoveryKeyUsed).toHaveBeenCalled();

      // Both will fail at network level, but not due to replay protection
      expect(personalResult.success).toBe(false);
      expect(workResult.success).toBe(false);
    });

    it("should enforce per-account replay protection independently", async () => {
      // Arrange: Two accounts where one has used the key, the other hasn't
      const personalClient = createMockClient("@user:example.com", "DEVICE_PERSONAL");
      const workClient = createMockClient("@user:work.com", "DEVICE_WORK");

      // Personal store: key already used
      const personalStore = {
        isRecoveryKeyUsed: vi.fn().mockReturnValue(true),
        markRecoveryKeyUsed: vi.fn(),
        setDeviceVerified: vi.fn(),
        setKeyBackupInfo: vi.fn(),
      } as unknown as VerificationStore;

      // Work store: key not used yet
      const workStore = {
        isRecoveryKeyUsed: vi.fn().mockReturnValue(false),
        markRecoveryKeyUsed: vi.fn(),
        setDeviceVerified: vi.fn(),
        setKeyBackupInfo: vi.fn(),
      } as unknown as VerificationStore;

      const personalHandler = new RecoveryKeyHandler(personalClient, personalStore);
      const workHandler = new RecoveryKeyHandler(workClient, workStore);

      registerMatrixRecoveryKeyHandler(personalHandler, "personal");
      registerMatrixRecoveryKeyHandler(workHandler, "work");

      const { encoded: testKey } = generateValidRecoveryKey();

      // Act: Use same key on both accounts
      const personalResult = await personalHandler.verifyWithRecoveryKey(testKey);
      const workResult = await workHandler.verifyWithRecoveryKey(testKey);

      // Assert: Personal account rejects (key already used)
      expect(personalResult.success).toBe(false);
      expect(personalResult.error).toContain("used recently");

      // Work account proceeds (independent replay protection)
      expect(workStore.isRecoveryKeyUsed).toHaveBeenCalled();
      expect(workResult.success).toBe(false); // Fails at network level, not replay
    });
  });

  describe("Account Lifecycle and Cleanup", () => {
    it("should properly unregister accounts without affecting others", () => {
      // Arrange: Register three accounts
      const client1 = createMockClient("@user1:example.com", "DEVICE1");
      const client2 = createMockClient("@user2:example.com", "DEVICE2");
      const client3 = createMockClient("@user3:example.com", "DEVICE3");

      const handler1 = new RecoveryKeyHandler(client1, createMockStore());
      const handler2 = new RecoveryKeyHandler(client2, createMockStore());
      const handler3 = new RecoveryKeyHandler(client3, createMockStore());

      registerMatrixRecoveryKeyHandler(handler1, "personal");
      registerMatrixRecoveryKeyHandler(handler2, "work");
      registerMatrixRecoveryKeyHandler(handler3, "test");

      expect(listRegisteredAccounts()).toHaveLength(3);

      // Act: Unregister middle account
      const removed = unregisterMatrixRecoveryKeyHandler("work");

      // Assert: Work account removed, others remain
      expect(removed).toBe(true);
      expect(listRegisteredAccounts()).toHaveLength(2);
      expect(listRegisteredAccounts()).toContain("personal");
      expect(listRegisteredAccounts()).toContain("test");
      expect(listRegisteredAccounts()).not.toContain("work");

      // Verify handlers still accessible for remaining accounts
      expect(getMatrixRecoveryKeyHandler("personal")).toBe(handler1);
      expect(getMatrixRecoveryKeyHandler("test")).toBe(handler3);
      expect(getMatrixRecoveryKeyHandler("work")).toBeNull();
    });

    it("should handle account re-registration (replacing handler)", () => {
      // Arrange: Register account
      const client1 = createMockClient("@user:example.com", "DEVICE1");
      const store1 = createMockStore();
      const handler1 = new RecoveryKeyHandler(client1, store1);

      registerMatrixRecoveryKeyHandler(handler1, "personal");
      expect(getMatrixRecoveryKeyHandler("personal")).toBe(handler1);

      // Act: Re-register same account with new handler
      const client2 = createMockClient("@user:example.com", "DEVICE2");
      const store2 = createMockStore();
      const handler2 = new RecoveryKeyHandler(client2, store2);

      registerMatrixRecoveryKeyHandler(handler2, "personal");

      // Assert: New handler replaces old one
      expect(getMatrixRecoveryKeyHandler("personal")).toBe(handler2);
      expect(getMatrixRecoveryKeyHandler("personal")).not.toBe(handler1);
      expect(getMatrixVerificationStore("personal")).toBe(store2);
      expect(listRegisteredAccounts()).toHaveLength(1);
    });
  });

  describe("Case-Insensitive Account Matching", () => {
    it("should handle case variations when accessing accounts", () => {
      // Arrange: Register with mixed case
      const client = createMockClient("@user:example.com", "DEVICE");
      const handler = new RecoveryKeyHandler(client, createMockStore());

      registerMatrixRecoveryKeyHandler(handler, "WorkAccount");

      // Act & Assert: Retrieve with different cases
      expect(getMatrixRecoveryKeyHandler("workaccount")).toBe(handler);
      expect(getMatrixRecoveryKeyHandler("WORKACCOUNT")).toBe(handler);
      expect(getMatrixRecoveryKeyHandler("WorkAccount")).toBe(handler);
      expect(getMatrixRecoveryKeyHandler("wOrKaCcOuNt")).toBe(handler);

      // Unregister with different case
      const removed = unregisterMatrixRecoveryKeyHandler("WORKACCOUNT");
      expect(removed).toBe(true);
      expect(getMatrixRecoveryKeyHandler("workaccount")).toBeNull();
    });

    it("should normalize account IDs in registry keys", () => {
      // Arrange: Register multiple accounts with mixed case
      const handler1 = new RecoveryKeyHandler(
        createMockClient("@user1:example.com", "DEVICE1"),
        createMockStore(),
      );
      const handler2 = new RecoveryKeyHandler(
        createMockClient("@user2:example.com", "DEVICE2"),
        createMockStore(),
      );

      registerMatrixRecoveryKeyHandler(handler1, "Personal");
      registerMatrixRecoveryKeyHandler(handler2, "WORK");

      // Act: List accounts
      const accounts = listRegisteredAccounts();

      // Assert: All accounts normalized to lowercase
      expect(accounts).toContain("personal");
      expect(accounts).toContain("work");
      expect(accounts).not.toContain("Personal");
      expect(accounts).not.toContain("WORK");
    });
  });

  describe("Default Account Fallback", () => {
    it("should use 'default' account when accountId is undefined", () => {
      // Arrange: Register default account
      const client = createMockClient("@user:example.com", "DEVICE");
      const handler = new RecoveryKeyHandler(client, createMockStore());

      // Act: Register without accountId (should default to "default")
      registerMatrixRecoveryKeyHandler(handler);

      // Assert: Retrievable as "default"
      expect(getMatrixRecoveryKeyHandler()).toBe(handler);
      expect(getMatrixRecoveryKeyHandler("default")).toBe(handler);
      expect(listRegisteredAccounts()).toContain("default");
    });

    it("should use 'default' account when accountId is null", () => {
      const client = createMockClient("@user:example.com", "DEVICE");
      const handler = new RecoveryKeyHandler(client, createMockStore());

      registerMatrixRecoveryKeyHandler(handler, null);

      expect(getMatrixRecoveryKeyHandler(null)).toBe(handler);
      expect(getMatrixRecoveryKeyHandler("default")).toBe(handler);
    });

    it("should use 'default' account when accountId is empty string", () => {
      const client = createMockClient("@user:example.com", "DEVICE");
      const handler = new RecoveryKeyHandler(client, createMockStore());

      registerMatrixRecoveryKeyHandler(handler, "");

      expect(getMatrixRecoveryKeyHandler("")).toBe(handler);
      expect(getMatrixRecoveryKeyHandler("default")).toBe(handler);
    });
  });

  describe("Concurrent Account Operations", () => {
    it("should handle concurrent verification requests on different accounts", async () => {
      // Arrange: Register two accounts
      const personalClient = createMockClient("@user:example.com", "DEVICE_PERSONAL");
      const workClient = createMockClient("@user:work.com", "DEVICE_WORK");

      const personalStore = createMockStore();
      const workStore = createMockStore();

      const personalHandler = new RecoveryKeyHandler(personalClient, personalStore);
      const workHandler = new RecoveryKeyHandler(workClient, workStore);

      registerMatrixRecoveryKeyHandler(personalHandler, "personal");
      registerMatrixRecoveryKeyHandler(workHandler, "work");

      const { encoded: key1 } = generateValidRecoveryKey();
      const { encoded: key2 } = generateValidRecoveryKey();

      // Act: Trigger concurrent verifications
      const [result1, result2] = await Promise.all([
        personalHandler.verifyWithRecoveryKey(key1),
        workHandler.verifyWithRecoveryKey(key2),
      ]);

      // Assert: Both operations complete independently
      expect(personalStore.isRecoveryKeyUsed).toHaveBeenCalled();
      expect(workStore.isRecoveryKeyUsed).toHaveBeenCalled();
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
    });

    it("should isolate verification state during concurrent operations", async () => {
      // Arrange: Two accounts with independent stores
      const client1 = createMockClient("@user1:example.com", "DEVICE1");
      const client2 = createMockClient("@user2:example.com", "DEVICE2");

      // Track method calls per store
      const store1Calls: string[] = [];
      const store2Calls: string[] = [];

      const store1 = {
        isRecoveryKeyUsed: vi.fn(() => {
          store1Calls.push("isRecoveryKeyUsed");
          return false;
        }),
        markRecoveryKeyUsed: vi.fn(() => {
          store1Calls.push("markRecoveryKeyUsed");
        }),
        setDeviceVerified: vi.fn(() => {
          store1Calls.push("setDeviceVerified");
        }),
        setKeyBackupInfo: vi.fn(() => {
          store1Calls.push("setKeyBackupInfo");
        }),
      } as unknown as VerificationStore;

      const store2 = {
        isRecoveryKeyUsed: vi.fn(() => {
          store2Calls.push("isRecoveryKeyUsed");
          return false;
        }),
        markRecoveryKeyUsed: vi.fn(() => {
          store2Calls.push("markRecoveryKeyUsed");
        }),
        setDeviceVerified: vi.fn(() => {
          store2Calls.push("setDeviceVerified");
        }),
        setKeyBackupInfo: vi.fn(() => {
          store2Calls.push("setKeyBackupInfo");
        }),
      } as unknown as VerificationStore;

      const handler1 = new RecoveryKeyHandler(client1, store1);
      const handler2 = new RecoveryKeyHandler(client2, store2);

      registerMatrixRecoveryKeyHandler(handler1, "account1");
      registerMatrixRecoveryKeyHandler(handler2, "account2");

      const { encoded: key1 } = generateValidRecoveryKey();
      const { encoded: key2 } = generateValidRecoveryKey();

      // Act: Concurrent verifications
      await Promise.all([
        handler1.verifyWithRecoveryKey(key1),
        handler2.verifyWithRecoveryKey(key2),
      ]);

      // Assert: Each store received its own calls (no cross-contamination)
      expect(store1Calls.length).toBeGreaterThan(0);
      expect(store2Calls.length).toBeGreaterThan(0);
      expect(store1Calls).toContain("isRecoveryKeyUsed");
      expect(store2Calls).toContain("isRecoveryKeyUsed");
    });
  });
});
