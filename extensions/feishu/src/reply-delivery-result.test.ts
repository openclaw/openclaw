import { PartialReplyDeliveryError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  mergeFeishuReplyDeliveryResults,
} from "./reply-delivery-result.js";
import { createFeishuSendReceipt } from "./send-result.js";

function sendResult(messageId: string, kind: "card" | "media" | "text") {
  return {
    messageId,
    receipt: createFeishuSendReceipt({ messageId, chatId: "oc_test", kind }),
  };
}

describe("Feishu reply delivery results", () => {
  it("keeps the first provider id primary and retains every physical send id", () => {
    const result = createFeishuReplyDeliveryResult({
      results: [sendResult("om_text", "text"), sendResult("om_media", "media")],
      visibleReplySent: true,
      content: "final text",
    });

    expect(result).toMatchObject({
      visibleReplySent: true,
      messageId: "om_text",
      content: "final text",
    });
    expect(result.receipt?.platformMessageIds).toEqual(["om_text", "om_media"]);
    expect(result.receipt?.parts.map((part) => part.kind)).toEqual(["text", "media"]);
  });

  it("does not expose provider identity for an explicitly non-visible result", () => {
    expect(
      createFeishuReplyDeliveryResult({
        results: [sendResult("om_hidden", "card")],
        visibleReplySent: false,
      }),
    ).toEqual({ visibleReplySent: false });
  });

  it("merges finalized card identity before supplemental media identity", () => {
    const result = mergeFeishuReplyDeliveryResults([
      createFeishuReplyDeliveryResult({
        results: [sendResult("om_card", "card")],
        visibleReplySent: true,
        content: "accepted final text",
      }),
      createFeishuReplyDeliveryResult({
        results: [sendResult("om_media", "media")],
        visibleReplySent: true,
      }),
    ]);

    expect(result.messageId).toBe("om_card");
    expect(result.content).toBe("accepted final text");
    expect(result.receipt?.platformMessageIds).toEqual(["om_card", "om_media"]);
  });

  it("carries visible provider identity through a later failed send", () => {
    const cause = new Error("media upload failed");
    const result = createFeishuReplyDeliveryResult({
      results: [sendResult("om_text", "text")],
      visibleReplySent: true,
      content: "accepted text",
    });

    const error = createFeishuPartialReplyDeliveryError(cause, result);

    expect(error).toBeInstanceOf(PartialReplyDeliveryError);
    expect(error).toMatchObject({
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        visibleReplySent: true,
        messageId: "om_text",
        content: "accepted text",
      },
    });
  });

  it("preserves the original failure when nothing became visible", () => {
    const cause = new Error("media upload failed");
    expect(createFeishuPartialReplyDeliveryError(cause, { visibleReplySent: false })).toBe(cause);
  });
});
