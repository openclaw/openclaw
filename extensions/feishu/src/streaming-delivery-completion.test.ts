import { PartialReplyDeliveryError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it, vi } from "vitest";
import { createFeishuReplyDeliveryResult } from "./reply-delivery-result.js";
import { createFeishuStreamingDeliveryCompletionQueue } from "./streaming-delivery-completion.js";

describe("Feishu streaming delivery completion", () => {
  it("resolves observers with finalized card identity and supplemental media ids", async () => {
    let completion: Promise<unknown> | undefined;
    const queue = createFeishuStreamingDeliveryCompletionQueue(
      (placeholder, pending) => {
        completion = pending;
        return placeholder;
      },
      async () =>
        createFeishuReplyDeliveryResult({
          results: [{ messageId: "om_card" }],
          visibleReplySent: true,
          content: "accepted final text",
          kind: "card",
        }),
      vi.fn(),
    );

    expect(
      queue.defer(
        createFeishuReplyDeliveryResult({
          results: [{ messageId: "om_media" }],
          visibleReplySent: true,
          kind: "media",
        }),
      ),
    ).toEqual({ visibleReplySent: false });

    await queue.queueIdle();
    await expect(completion).resolves.toMatchObject({
      visibleReplySent: true,
      messageId: "om_card",
      content: "accepted final text",
      receipt: { platformMessageIds: ["om_card", "om_media"] },
    });
  });

  it("rejects deferred observers when provider finalization fails", async () => {
    let completion: Promise<unknown> | undefined;
    const queue = createFeishuStreamingDeliveryCompletionQueue(
      (placeholder, pending) => {
        completion = pending;
        return placeholder;
      },
      async () => {
        throw new Error("finalization failed");
      },
      vi.fn(),
    );

    queue.defer();
    await expect(queue.queueIdle()).rejects.toThrow("finalization failed");
    await expect(completion).rejects.toThrow("finalization failed");
  });

  it("reports card finalization failure with already-visible supplemental media", async () => {
    let completion: Promise<unknown> | undefined;
    const queue = createFeishuStreamingDeliveryCompletionQueue(
      (placeholder, pending) => {
        completion = pending;
        return placeholder;
      },
      async () => {
        throw new Error("finalization failed");
      },
      vi.fn(),
    );

    queue.defer(
      createFeishuReplyDeliveryResult({
        results: [{ messageId: "om_media" }],
        visibleReplySent: true,
        kind: "media",
      }),
    );
    await expect(queue.queueIdle()).rejects.toThrow("finalization failed");
    await expect(completion).rejects.toMatchObject({
      name: "PartialReplyDeliveryError",
      deliveryResult: {
        visibleReplySent: true,
        messageId: "om_media",
      },
    });
  });

  it("reports a prior media failure after card finalization supplies the visible identity", async () => {
    let completion: Promise<unknown> | undefined;
    const queue = createFeishuStreamingDeliveryCompletionQueue(
      (owner, pending) => {
        completion = pending;
        return owner;
      },
      async () =>
        createFeishuReplyDeliveryResult({
          results: [{ messageId: "om_card" }],
          visibleReplySent: true,
          content: "accepted final text",
          kind: "card",
        }),
      vi.fn(),
    );
    const providerError = new Error("media upload failed");

    expect(queue.deferFailure(providerError)).toBe(providerError);
    await queue.queueIdle();

    await expect(completion).rejects.toBeInstanceOf(PartialReplyDeliveryError);
    await expect(completion).rejects.toMatchObject({
      deliveryResult: {
        visibleReplySent: true,
        messageId: "om_card",
        content: "accepted final text",
      },
    });
  });
});
