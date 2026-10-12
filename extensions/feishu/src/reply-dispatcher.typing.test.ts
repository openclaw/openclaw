import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTypingIndicatorMock,
  sendMessageFeishuMock,
  sendMediaFeishuMock,
  resolveFeishuAccountMock,
  createReplyAccount,
  createDispatcherHarness,
  useNonStreamingAutoAccount,
  resetFeishuReplyDispatcherHarness,
} from "./reply-dispatcher.test-support.js";

describe("createFeishuReplyDispatcher typing ownership", () => {
  beforeEach(resetFeishuReplyDispatcherHarness);
  it.each(["disabled", "stale seconds", "processing owner"])(
    "suppresses typing for %s messages",
    async (reason) => {
      if (reason === "disabled") {
        resolveFeishuAccountMock.mockReturnValue(
          createReplyAccount("auto", "partial", "feishu", { typingIndicator: false }),
        );
      }
      const { options } = createDispatcherHarness({
        replyToMessageId: "om_parent",
        processingStatus:
          reason === "processing owner"
            ? { queued: vi.fn(), included: vi.fn(), abandoned: vi.fn(), settled: vi.fn() }
            : undefined,
        messageCreateTimeMs:
          reason === "stale seconds" ? Math.floor((Date.now() - 3 * 60_000) / 1000) : undefined,
      });
      await options.onReplyStart?.();
      expect(addTypingIndicatorMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "topic root",
      replyToMessageId: "om_topic_root",
      rootId: "om_topic_root",
      fallback: false,
    },
    {
      name: "quoted reply",
      replyToMessageId: "om_quote_reply",
      rootId: "om_original_msg",
      fallback: true,
    },
  ])(
    "routes $name replies and inbound typing independently",
    async ({ replyToMessageId, rootId, fallback }) => {
      useNonStreamingAutoAccount();
      const { options } = createDispatcherHarness({
        replyToMessageId,
        rootId,
        typingTargetMessageId: "om_topic_child",
        threadReply: true,
        replyInThread: true,
        messageCreateTimeMs: Date.now() - 30_000,
      });
      await options.onReplyStart?.();
      await options.deliver(
        { text: "plain text", mediaUrl: "https://example.com/reply.png" },
        { kind: "final" },
      );
      expect(addTypingIndicatorMock).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "om_topic_child" }),
      );
      for (const sender of [sendMessageFeishuMock, sendMediaFeishuMock]) {
        expect(sender).toHaveBeenCalledWith(
          expect.objectContaining({
            replyToMessageId,
            replyInThread: true,
            allowTopLevelReplyFallback: fallback,
          }),
        );
      }
    },
  );
});
