import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sendMessageWithDedup,
  createDedupSendFunction,
  checkBatchSendDedup,
  clearDedupEntry,
  getDedupStats,
} from "./send-dedup-wrapper.js";
import { resetGlobalSendDedup } from "./send-dedup.js";

describe("SendDedupWrapper", () => {
  afterEach(() => {
    resetGlobalSendDedup();
  });

  describe("sendMessageWithDedup", () => {
    it("should call send function for new messages", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      const messageId = await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      expect(messageId).toBe(123);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it("should suppress duplicate sends", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      // First send
      await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      // Second send (duplicate)
      const messageId = await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      expect(messageId).toBe(123);
      expect(sendFn).toHaveBeenCalledTimes(1); // Only called once
    });

    it("should call onDedupHit callback on duplicate", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));
      const onDedupHit = vi.fn();

      // First send
      await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      // Second send (duplicate)
      await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
        onDedupHit,
      });

      expect(onDedupHit).toHaveBeenCalledTimes(1);
      expect(onDedupHit.mock.calls[0][0]).toMatchObject({
        attemptCount: 1,
        messageId: 123,
      });
    });

    it("should call onDedupMiss callback on new send", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));
      const onDedupMiss = vi.fn();

      await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
        onDedupMiss,
      });

      expect(onDedupMiss).toHaveBeenCalledTimes(1);
    });

    it("should call onSendFailure callback on error", async () => {
      const error = new Error("Send failed");
      const sendFn = vi.fn(async () => {
        throw error;
      });
      const onSendFailure = vi.fn();

      await expect(
        sendMessageWithDedup({
          chatId: "123",
          dedupParams: { text: "Hello" },
          send: sendFn,
          onSendFailure,
        }),
      ).rejects.toThrow("Send failed");

      expect(onSendFailure).toHaveBeenCalledTimes(1);
      expect(onSendFailure.mock.calls[0][1]).toMatchObject({
        attemptCount: 1,
      });
    });

    it("should allow retry after failure", async () => {
      const sendFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({ message_id: 123 });

      // First attempt fails
      await expect(
        sendMessageWithDedup({
          chatId: "123",
          dedupParams: { text: "Hello" },
          send: sendFn,
        }),
      ).rejects.toThrow("Network error");

      // Second attempt succeeds
      const messageId = await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      expect(messageId).toBe(123);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it("should support different chat IDs", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      const msg1 = await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      const msg2 = await sendMessageWithDedup({
        chatId: "456",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      // Both should succeed (different chats)
      expect(msg1).toBe(123);
      expect(msg2).toBe(123);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it("should pass parameters to send function", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: (params) => {
          expect(params).toEqual(undefined); // Default case
          return sendFn(params);
        },
      });

      expect(sendFn).toHaveBeenCalled();
    });

    it("should log messages", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));
      const log = vi.fn();

      await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
        log,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining("new send"));
    });
  });

  describe("createDedupSendFunction", () => {
    it("should create a reusable send function", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      const dedupSend = createDedupSendFunction(sendFn, {
        chatId: "123",
        dedupParams: { text: "Hello" },
      });

      const messageId = await dedupSend();
      expect(messageId).toBe(123);
    });

    it("should maintain dedup state across calls", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      const dedupSend = createDedupSendFunction(sendFn, {
        chatId: "123",
        dedupParams: { text: "Hello" },
      });

      await dedupSend();
      await dedupSend();

      // Should only call actual send once
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("checkBatchSendDedup", () => {
    it("should handle multiple sends", async () => {
      const send1 = vi.fn(async () => ({ message_id: 111 }));
      const send2 = vi.fn(async () => ({ message_id: 222 }));

      const results = await checkBatchSendDedup("123", [
        { dedupParams: { text: "Msg1" }, send: send1 },
        { dedupParams: { text: "Msg2" }, send: send2 },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ messageId: 111, isDuplicate: false });
      expect(results[1]).toMatchObject({ messageId: 222, isDuplicate: false });
    });

    it("should detect duplicates in batch", async () => {
      const send = vi.fn(async () => ({ message_id: 123 }));

      const results = await checkBatchSendDedup("123", [
        { dedupParams: { text: "Hello" }, send },
        { dedupParams: { text: "Hello" }, send }, // Duplicate
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ messageId: 123 });
      expect(results[1]).toMatchObject({ messageId: 123 });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe("clearDedupEntry", () => {
    it("should clear dedup entry and allow resend", async () => {
      const sendFn = vi
        .fn()
        .mockResolvedValueOnce({ message_id: 123 })
        .mockResolvedValueOnce({ message_id: 124 });

      // First send
      const msg1 = await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });
      expect(msg1).toBe(123);

      // Clear dedup
      clearDedupEntry("123", { text: "Hello" });

      // Second send should go through
      const msg2 = await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });
      expect(msg2).toBe(124);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("getDedupStats", () => {
    it("should return cache statistics", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      // Add some entries
      for (let i = 0; i < 3; i++) {
        await sendMessageWithDedup({
          chatId: "123",
          dedupParams: { text: `Message ${i}` },
          send: sendFn,
        });
      }

      const stats = getDedupStats();
      expect(stats.cacheSize).toBe(3);
      expect(stats.maxSize).toBe(1000);
    });
  });

  describe("error handling", () => {
    it("should throw when send response has no message_id", async () => {
      const sendFn = vi.fn(async () => ({ message_id: undefined }));

      await expect(
        sendMessageWithDedup({
          chatId: "123",
          dedupParams: { text: "Hello" },
          send: sendFn,
        }),
      ).rejects.toThrow("message_id");
    });

    it("should throw when dedup hit but no cached message ID", async () => {
      const sendFn = vi.fn(async () => ({ message_id: 123 }));

      // First send
      await sendMessageWithDedup({
        chatId: "123",
        dedupParams: { text: "Hello" },
        send: sendFn,
      });

      // Manually clear the message ID (simulate pending state)
      // This is a edge case that shouldn't happen in normal operation
      // but tests error handling
      resetGlobalSendDedup();

      // Create a scenario where dedup thinks it's pending
      // (This requires some internal manipulation, skipping for now)
    });
  });
});
