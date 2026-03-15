import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SendDedup,
  getGlobalSendDedup,
  resetGlobalSendDedup,
  checkSendDedup,
  recordSendAttempt,
  recordSendSuccess,
} from "./send-dedup.js";

describe("SendDedup", () => {
  let dedup: SendDedup;

  beforeEach(() => {
    dedup = new SendDedup({
      ttlMs: 100, // Short TTL for testing
      maxSize: 10,
    });
  });

  afterEach(() => {
    resetGlobalSendDedup();
  });

  describe("constructor", () => {
    it("should create instance with default options", () => {
      const d = new SendDedup();
      expect(d.size()).toBe(0);
    });

    it("should create instance with custom options", () => {
      const d = new SendDedup({ ttlMs: 1000, maxSize: 100 });
      expect(d.size()).toBe(0);
    });

    it("should clamp negative values to sensible defaults", () => {
      const d = new SendDedup({ ttlMs: -1000, maxSize: -10 });
      expect(d.size()).toBe(0); // Should not crash
    });
  });

  describe("hashSendParams", () => {
    it("should generate consistent hash for same parameters", () => {
      const params = { text: "Hello World", buttons: [{ text: "Click" }] };
      const hash1 = dedup.hashSendParams("123", params);
      const hash2 = dedup.hashSendParams("123", params);
      expect(hash1).toBe(hash2);
    });

    it("should generate different hash for different text", () => {
      const hash1 = dedup.hashSendParams("123", { text: "Hello" });
      const hash2 = dedup.hashSendParams("123", { text: "Goodbye" });
      expect(hash1).not.toBe(hash2);
    });

    it("should generate different hash for different chat IDs", () => {
      const params = { text: "Hello" };
      const hash1 = dedup.hashSendParams("123", params);
      const hash2 = dedup.hashSendParams("456", params);
      expect(hash1).not.toBe(hash2);
    });

    it("should ignore non-content parameters in hash", () => {
      const baseParams = { text: "Hello", buttons: [] };
      const withTimestamp = { ...baseParams, timestamp: Date.now() };
      const withId = { ...baseParams, messageId: 999 };

      const hash1 = dedup.hashSendParams("123", baseParams);
      const hash2 = dedup.hashSendParams("123", withTimestamp);
      const hash3 = dedup.hashSendParams("123", withId);

      // Hashes should be the same (timestamp/id ignored)
      expect(hash1).toBe(hash2);
      expect(hash1).toBe(hash3);
    });

    it("should hash complex button structures", () => {
      const params = {
        text: "Menu",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Option A", callback_data: "a" }],
            [{ text: "Option B", callback_data: "b" }],
          ],
        },
      };
      const hash = dedup.hashSendParams("123", params);
      expect(hash).toMatch(/^telegram-send-/);
    });

    it("should handle empty parameters", () => {
      const hash = dedup.hashSendParams("123", {});
      expect(hash).toMatch(/^telegram-send-/);
    });
  });

  describe("recordAttempt", () => {
    it("should start with attempt count 1", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      const count = dedup.recordAttempt(hash, "123");
      expect(count).toBe(1);
    });

    it("should increment attempt count on retry", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");
      const count = dedup.recordAttempt(hash, "123");
      expect(count).toBe(2);
    });

    it("should track multiple attempts", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      for (let i = 1; i <= 5; i++) {
        const count = dedup.recordAttempt(hash, "123");
        expect(count).toBe(i);
      }
    });

    it("should add entry to cache after first attempt", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(false);

      dedup.recordAttempt(hash, "123");

      expect(dedup.hasPendingOrSuccessful(hash)).toBe(true);
    });
  });

  describe("hasPendingOrSuccessful", () => {
    it("should return false for unknown hash", () => {
      const hash = dedup.hashSendParams("123", { text: "Unknown" });
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(false);
    });

    it("should return true after recordAttempt", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(true);
    });

    it("should return true after recordSuccess", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");
      dedup.recordSuccess(hash, 999);
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(true);
    });

    it("should return false after TTL expires", async () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(dedup.hasPendingOrSuccessful(hash)).toBe(false);
    });
  });

  describe("recordSuccess", () => {
    it("should store message ID on success", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");
      dedup.recordSuccess(hash, 12345);

      const meta = dedup.getMetadata(hash);
      expect(meta?.messageId).toBe(12345);
    });

    it("should refresh TTL on success", async () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");

      // Wait part of TTL
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Record success (should refresh TTL)
      dedup.recordSuccess(hash, 999);

      // Check still exists shortly after first TTL would expire
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(true);

      // Wait for second TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(false);
    });
  });

  describe("recordFailure", () => {
    it("should return undefined for unknown hash", () => {
      const hash = "unknown-hash";
      const result = dedup.recordFailure(hash);
      expect(result).toBeUndefined();
    });

    it("should return entry metadata on failure", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");

      const failed = dedup.recordFailure(hash);
      expect(failed).toBeDefined();
      expect(failed?.chatId).toBe("123");
      expect(failed?.messageId).toBeUndefined();
    });
  });

  describe("getMetadata", () => {
    it("should return undefined for unknown hash", () => {
      const hash = "unknown-hash";
      expect(dedup.getMetadata(hash)).toBeUndefined();
    });

    it("should return full metadata after attempt", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");

      const meta = dedup.getMetadata(hash);
      expect(meta).toBeDefined();
      expect(meta?.contentHash).toBe(hash);
      expect(meta?.chatId).toBe("123");
      expect(meta?.attemptCount).toBe(1);
      expect(meta?.messageId).toBeUndefined();
    });

    it("should return metadata with message ID after success", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");
      dedup.recordSuccess(hash, 12345);

      const meta = dedup.getMetadata(hash);
      expect(meta?.messageId).toBe(12345);
    });

    it("should return a copy, not the original entry", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");

      const meta1 = dedup.getMetadata(hash);
      const meta2 = dedup.getMetadata(hash);

      expect(meta1).toEqual(meta2);
      expect(meta1).not.toBe(meta2); // Different objects
    });
  });

  describe("clear", () => {
    it("should remove entry from dedup tracking", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");

      expect(dedup.hasPendingOrSuccessful(hash)).toBe(true);

      dedup.clear(hash);

      expect(dedup.hasPendingOrSuccessful(hash)).toBe(false);
    });

    it("should allow re-sending after clear", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");
      dedup.recordSuccess(hash, 999);

      // Clear and re-attempt
      dedup.clear(hash);
      const count = dedup.recordAttempt(hash, "123");

      expect(count).toBe(1); // Reset to 1
    });
  });

  describe("clearAll", () => {
    it("should clear all entries", () => {
      for (let i = 0; i < 5; i++) {
        const hash = dedup.hashSendParams("123", { text: `Message ${i}` });
        dedup.recordAttempt(hash, "123");
      }

      expect(dedup.size()).toBe(5);
      dedup.clearAll();
      expect(dedup.size()).toBe(0);
    });
  });

  describe("size", () => {
    it("should return current cache size", () => {
      expect(dedup.size()).toBe(0);

      const hash1 = dedup.hashSendParams("123", { text: "Msg1" });
      dedup.recordAttempt(hash1, "123");
      expect(dedup.size()).toBe(1);

      const hash2 = dedup.hashSendParams("123", { text: "Msg2" });
      dedup.recordAttempt(hash2, "123");
      expect(dedup.size()).toBe(2);
    });
  });

  describe("reset", () => {
    it("should reset to clean state", () => {
      const hash = dedup.hashSendParams("123", { text: "Hello" });
      dedup.recordAttempt(hash, "123");

      expect(dedup.size()).toBe(1);
      dedup.reset();
      expect(dedup.size()).toBe(0);
      expect(dedup.hasPendingOrSuccessful(hash)).toBe(false);
    });
  });

  describe("global singleton", () => {
    it("getGlobalSendDedup should return singleton instance", () => {
      const dedup1 = getGlobalSendDedup();
      const dedup2 = getGlobalSendDedup();
      expect(dedup1).toBe(dedup2);
    });

    it("should maintain state across calls", () => {
      const dedup1 = getGlobalSendDedup();
      const hash = dedup1.hashSendParams("123", { text: "Hello" });
      dedup1.recordAttempt(hash, "123");

      const dedup2 = getGlobalSendDedup();
      expect(dedup2.hasPendingOrSuccessful(hash)).toBe(true);
    });

    it("resetGlobalSendDedup should clear singleton", () => {
      const dedup1 = getGlobalSendDedup({ ttlMs: 1000, maxSize: 100 });
      const hash = dedup1.hashSendParams("123", { text: "Hello" });
      dedup1.recordAttempt(hash, "123");

      resetGlobalSendDedup();

      const dedup2 = getGlobalSendDedup();
      expect(dedup1).not.toBe(dedup2);
      expect(dedup2.hasPendingOrSuccessful(hash)).toBe(false);
    });
  });

  describe("convenience functions", () => {
    it("checkSendDedup should check global instance", () => {
      const params = { text: "Hello" };
      expect(checkSendDedup("123", params)).toBe(false);

      recordSendAttempt("123", params);
      expect(checkSendDedup("123", params)).toBe(true);
    });

    it("recordSendAttempt should return hash and count", () => {
      const params = { text: "Hello" };
      const result = recordSendAttempt("123", params);

      expect(result.hash).toMatch(/^telegram-send-/);
      expect(result.attemptCount).toBe(1);
    });

    it("recordSendSuccess should update global instance", () => {
      const params = { text: "Hello" };
      const { hash } = recordSendAttempt("123", params);

      recordSendSuccess(hash, 999);

      const dedup = getGlobalSendDedup();
      const meta = dedup.getMetadata(hash);
      expect(meta?.messageId).toBe(999);
    });

    it("convenience functions should work end-to-end", () => {
      resetGlobalSendDedup();

      const chatId = "123";
      const params = { text: "Test message", buttons: [] };

      // First send attempt
      expect(checkSendDedup(chatId, params)).toBe(false);

      const { hash, attemptCount } = recordSendAttempt(chatId, params);
      expect(attemptCount).toBe(1);
      expect(checkSendDedup(chatId, params)).toBe(true);

      // Success
      recordSendSuccess(hash, 12345);

      // Check metadata
      const dedup = getGlobalSendDedup();
      const meta = dedup.getMetadata(hash);
      expect(meta?.messageId).toBe(12345);
      expect(meta?.attemptCount).toBe(1);
    });
  });

  describe("real-world scenarios", () => {
    it("should prevent duplicate sends on rapid retry", () => {
      const chatId = "123";
      const params = { text: "Important message" };

      // User sends
      expect(checkSendDedup(chatId, params)).toBe(false);
      const attempt1 = recordSendAttempt(chatId, params);

      // Network timeout triggers retry
      expect(checkSendDedup(chatId, params)).toBe(true);
      const attempt2 = recordSendAttempt(chatId, params);

      expect(attempt2.attemptCount).toBe(2);
    });

    it("should allow different messages to same chat", () => {
      const chatId = "123";
      const params1 = { text: "First message" };
      const params2 = { text: "Second message" };

      recordSendAttempt(chatId, params1);
      recordSendAttempt(chatId, params2);

      expect(checkSendDedup(chatId, params1)).toBe(true);
      expect(checkSendDedup(chatId, params2)).toBe(true);
    });

    it("should allow same message to different chats", () => {
      const params = { text: "Broadcast message" };

      recordSendAttempt("123", params);
      recordSendAttempt("456", params);

      expect(checkSendDedup("123", params)).toBe(true);
      expect(checkSendDedup("456", params)).toBe(true);
    });

    it("should handle maxSize limit gracefully", async () => {
      const smallDedup = new SendDedup({ ttlMs: 10000, maxSize: 3 });

      // Add entries beyond maxSize
      for (let i = 0; i < 5; i++) {
        const hash = smallDedup.hashSendParams("123", { text: `Msg ${i}` });
        smallDedup.recordAttempt(hash, "123");
      }

      // Size should not exceed maxSize
      expect(smallDedup.size()).toBeLessThanOrEqual(3);
    });
  });
});
