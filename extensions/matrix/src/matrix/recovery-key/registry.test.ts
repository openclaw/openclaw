/**
 * Unit tests for multi-account recovery key registry.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RecoveryKeyHandler } from "./handler.js";
import type { RecoveryKeyStore } from "./store.js";
import {
  registerMatrixRecoveryKeyHandler,
  getMatrixRecoveryKeyHandler,
  getMatrixVerificationStore,
  unregisterMatrixRecoveryKeyHandler,
  listRegisteredAccounts,
} from "./registry.js";

describe("Multi-Account Registry", () => {
  let mockHandler1: RecoveryKeyHandler;
  let mockHandler2: RecoveryKeyHandler;
  let mockStore1: RecoveryKeyStore;
  let mockStore2: RecoveryKeyStore;

  beforeEach(() => {
    // Create mock handlers and stores
    mockStore1 = {
      isRecoveryKeyUsed: vi.fn(),
      markRecoveryKeyUsed: vi.fn(),
      setDeviceVerified: vi.fn(),
    } as unknown as RecoveryKeyStore;

    mockStore2 = {
      isRecoveryKeyUsed: vi.fn(),
      markRecoveryKeyUsed: vi.fn(),
      setDeviceVerified: vi.fn(),
    } as unknown as RecoveryKeyStore;

    mockHandler1 = {
      getStore: vi.fn().mockReturnValue(mockStore1),
      verifyWithRecoveryKey: vi.fn(),
    } as unknown as RecoveryKeyHandler;

    mockHandler2 = {
      getStore: vi.fn().mockReturnValue(mockStore2),
      verifyWithRecoveryKey: vi.fn(),
    } as unknown as RecoveryKeyHandler;

    // Clear registry before each test
    for (const accountId of listRegisteredAccounts()) {
      unregisterMatrixRecoveryKeyHandler(accountId);
    }
  });

  describe("registerMatrixRecoveryKeyHandler", () => {
    it("should register handler for default account when accountId is undefined", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1);

      const handler = getMatrixRecoveryKeyHandler();
      expect(handler).toBe(mockHandler1);
    });

    it("should register handler for default account when accountId is null", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, null);

      const handler = getMatrixRecoveryKeyHandler();
      expect(handler).toBe(mockHandler1);
    });

    it("should register handler for specified account", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");

      const handler = getMatrixRecoveryKeyHandler("personal");
      expect(handler).toBe(mockHandler1);
    });

    it("should register multiple handlers for different accounts", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      expect(getMatrixRecoveryKeyHandler("personal")).toBe(mockHandler1);
      expect(getMatrixRecoveryKeyHandler("work")).toBe(mockHandler2);
    });

    it("should normalize account IDs (case-insensitive)", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "Personal");

      // Should retrieve with lowercase
      expect(getMatrixRecoveryKeyHandler("personal")).toBe(mockHandler1);
      expect(getMatrixRecoveryKeyHandler("PERSONAL")).toBe(mockHandler1);
      expect(getMatrixRecoveryKeyHandler("PeRsOnAl")).toBe(mockHandler1);
    });

    it("should replace existing handler when re-registering same account", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "personal");

      const handler = getMatrixRecoveryKeyHandler("personal");
      expect(handler).toBe(mockHandler2);
      expect(handler).not.toBe(mockHandler1);
    });

    it("should cache store reference during registration", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");

      const store = getMatrixVerificationStore("personal");
      expect(store).toBe(mockStore1);
      expect(mockHandler1.getStore).toHaveBeenCalledTimes(1);
    });
  });

  describe("getMatrixRecoveryKeyHandler", () => {
    it("should return null for unregistered account", () => {
      const handler = getMatrixRecoveryKeyHandler("nonexistent");
      expect(handler).toBeNull();
    });

    it("should return null when no accounts registered", () => {
      const handler = getMatrixRecoveryKeyHandler();
      expect(handler).toBeNull();
    });

    it("should retrieve handler for specified account", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      expect(getMatrixRecoveryKeyHandler("personal")).toBe(mockHandler1);
      expect(getMatrixRecoveryKeyHandler("work")).toBe(mockHandler2);
    });

    it("should default to 'default' account when accountId is undefined", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "default");

      const handler = getMatrixRecoveryKeyHandler();
      expect(handler).toBe(mockHandler1);
    });

    it("should normalize account ID for lookup", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");

      expect(getMatrixRecoveryKeyHandler("PERSONAL")).toBe(mockHandler1);
      expect(getMatrixRecoveryKeyHandler("Personal")).toBe(mockHandler1);
    });
  });

  describe("getMatrixVerificationStore", () => {
    it("should return null for unregistered account", () => {
      const store = getMatrixVerificationStore("nonexistent");
      expect(store).toBeNull();
    });

    it("should return null when no accounts registered", () => {
      const store = getMatrixVerificationStore();
      expect(store).toBeNull();
    });

    it("should retrieve store for specified account", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      expect(getMatrixVerificationStore("personal")).toBe(mockStore1);
      expect(getMatrixVerificationStore("work")).toBe(mockStore2);
    });

    it("should default to 'default' account when accountId is undefined", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "default");

      const store = getMatrixVerificationStore();
      expect(store).toBe(mockStore1);
    });

    it("should normalize account ID for lookup", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");

      expect(getMatrixVerificationStore("PERSONAL")).toBe(mockStore1);
      expect(getMatrixVerificationStore("Personal")).toBe(mockStore1);
    });

    it("should not call handler.getStore() on repeated access", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");

      // Store is cached during registration
      getMatrixVerificationStore("personal");
      getMatrixVerificationStore("personal");
      getMatrixVerificationStore("personal");

      // getStore() should only be called once during registration
      expect(mockHandler1.getStore).toHaveBeenCalledTimes(1);
    });
  });

  describe("unregisterMatrixRecoveryKeyHandler", () => {
    it("should unregister handler and store for specified account", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");

      const removed = unregisterMatrixRecoveryKeyHandler("personal");

      expect(removed).toBe(true);
      expect(getMatrixRecoveryKeyHandler("personal")).toBeNull();
      expect(getMatrixVerificationStore("personal")).toBeNull();
    });

    it("should return false when unregistering nonexistent account", () => {
      const removed = unregisterMatrixRecoveryKeyHandler("nonexistent");

      expect(removed).toBe(false);
    });

    it("should only remove specified account, not others", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      unregisterMatrixRecoveryKeyHandler("personal");

      expect(getMatrixRecoveryKeyHandler("personal")).toBeNull();
      expect(getMatrixRecoveryKeyHandler("work")).toBe(mockHandler2);
    });

    it("should normalize account ID for removal", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");

      const removed = unregisterMatrixRecoveryKeyHandler("PERSONAL");

      expect(removed).toBe(true);
      expect(getMatrixRecoveryKeyHandler("personal")).toBeNull();
    });

    it("should default to 'default' account when accountId is undefined", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "default");

      const removed = unregisterMatrixRecoveryKeyHandler();

      expect(removed).toBe(true);
      expect(getMatrixRecoveryKeyHandler()).toBeNull();
    });
  });

  describe("listRegisteredAccounts", () => {
    it("should return empty array when no accounts registered", () => {
      const accounts = listRegisteredAccounts();

      expect(accounts).toEqual([]);
    });

    it("should return array of registered account IDs", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      const accounts = listRegisteredAccounts();

      expect(accounts).toHaveLength(2);
      expect(accounts).toContain("personal");
      expect(accounts).toContain("work");
    });

    it("should return normalized account IDs", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "Personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "WORK");

      const accounts = listRegisteredAccounts();

      expect(accounts).toContain("personal");
      expect(accounts).toContain("work");
    });

    it("should update list when accounts are unregistered", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      expect(listRegisteredAccounts()).toHaveLength(2);

      unregisterMatrixRecoveryKeyHandler("personal");

      const accounts = listRegisteredAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts).toContain("work");
      expect(accounts).not.toContain("personal");
    });
  });

  describe("Account Isolation", () => {
    it("should maintain independent state for each account", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      const handler1 = getMatrixRecoveryKeyHandler("personal");
      const handler2 = getMatrixRecoveryKeyHandler("work");
      const store1 = getMatrixVerificationStore("personal");
      const store2 = getMatrixVerificationStore("work");

      // Each account has independent handler and store
      expect(handler1).not.toBe(handler2);
      expect(store1).not.toBe(store2);
    });

    it("should not affect other accounts when unregistering one", () => {
      registerMatrixRecoveryKeyHandler(mockHandler1, "personal");
      registerMatrixRecoveryKeyHandler(mockHandler2, "work");

      unregisterMatrixRecoveryKeyHandler("personal");

      // Work account should remain unaffected
      expect(getMatrixRecoveryKeyHandler("work")).toBe(mockHandler2);
      expect(getMatrixVerificationStore("work")).toBe(mockStore2);
    });
  });
});
