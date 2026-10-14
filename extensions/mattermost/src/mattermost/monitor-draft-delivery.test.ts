// Mattermost tests cover draft-preview delivery settlement.
import { setImmediate } from "node:timers/promises";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createLivePreviewLifecycle,
  createMessageReceiptFromOutboundResults,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "./client.js";
import type { MattermostClient } from "./client.js";
import { deliverMattermostReplyWithDraftPreview } from "./monitor-draft-delivery.js";
import type { ReplyPayload } from "./runtime-api.js";

const updateMattermostPostSpy = vi.spyOn(clientModule, "updateMattermostPost");

function createMattermostClientMock(): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: vi.fn(async () => ({})) as MattermostClient["request"],
    fetchImpl: vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as MattermostClient["fetchImpl"],
  };
}

function createMattermostReceipt(messageId: string, kind: "text" | "preview" | "media") {
  return createMessageReceiptFromOutboundResults({
    results: [{ channel: "mattermost", messageId }],
    kind,
  });
}

function createConfirmedPreviewDelivery(messageId: string, content: string) {
  return {
    outcome: "text" as const,
    messageIds: [messageId],
    receipt: createMattermostReceipt(messageId, "preview"),
    visibleReplySent: true,
    content,
  };
}

type DraftStreamMock = {
  flush: () => Promise<void>;
  postId: () => string | undefined;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
};

function createDraftStreamMock(postId: string | null | undefined = "preview-post-1") {
  return {
    flush: vi.fn(async () => {}),
    postId: vi.fn(() => postId ?? undefined),
    clear: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
  };
}

function createDeliverFinalMock() {
  return vi.fn(async (payload: { text?: string }) => ({
    outcome: "text" as const,
    messageIds: ["delivered-post-1"],
    receipt: createMattermostReceipt("delivered-post-1", "text"),
    visibleReplySent: true,
    content: payload.text ?? "",
  }));
}

function resolvePreviewFinalText(text?: string) {
  const editText = text?.trim();
  return editText ? { editText, alreadyDelivered: false } : undefined;
}

function createPreviewLifecycle(draftStream: DraftStreamMock) {
  return createLivePreviewLifecycle<ReplyPayload, string>({
    draft: { ...draftStream, id: draftStream.postId },
  });
}

type DraftDeliveryParams = Parameters<typeof deliverMattermostReplyWithDraftPreview>[0];

function deliverDraftPreview(
  params: Pick<DraftDeliveryParams, "payload" | "deliverPayload"> & {
    draftStream: DraftStreamMock;
  } & Partial<Omit<DraftDeliveryParams, "payload" | "deliverPayload">>,
) {
  return deliverMattermostReplyWithDraftPreview({
    info: { kind: "final" },
    kind: "channel",
    client: createMattermostClientMock(),
    resolvePreviewFinalText,
    previewLifecycle: createPreviewLifecycle(params.draftStream),
    logVerboseMessage: vi.fn(),
    ...params,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMattermostPostSpy.mockResolvedValue({ id: "patched" } as never);
});

describe("deliverMattermostReplyWithDraftPreview", () => {
  it("suppresses reasoning-prefixed finals before preview finalization", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const recordThreadParticipation = vi.fn();

    await deliverDraftPreview({
      payload: { text: "  \n > Reasoning:\n> _hidden_" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      recordThreadParticipation,
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).not.toHaveBeenCalled();
    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
    // No visible reply was sent, so the thread must not be marked as participated.
    expect(recordThreadParticipation).not.toHaveBeenCalled();
  });

  it("records thread participation when a same-thread final finalizes the preview in place", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const recording = createDeferred<void>();
    const registered = createDeferred<void>();
    const recordThreadParticipation = vi.fn(() => {
      recording.resolve();
      return registered.promise;
    });
    let settled = false;

    const delivery = deliverDraftPreview({
      payload: { text: "All good" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      recordThreadParticipation,
      deliverPayload: deliverFinal,
    }).finally(() => {
      settled = true;
    });
    try {
      await recording.promise;
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      registered.resolve();
      await delivery;
    }
    const result = await delivery;

    // Default streaming finalizes by editing the preview post, bypassing deliverPayload —
    // participation must still be recorded (regression: PR #95552 review P1).
    expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
      message: "All good",
    });
    expect(deliverFinal).not.toHaveBeenCalled();
    expect(draftStream.seal).toHaveBeenCalledTimes(1);
    expect(draftStream.seal.mock.invocationCallOrder[0]).toBeLessThan(
      updateMattermostPostSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(recordThreadParticipation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "text",
      messageIds: ["patched"],
      visibleReplySent: true,
      content: "All good",
    });
  });

  it("delivers native value buttons instead of losing them in a preview edit", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };
    const payload = { text: "Choose an option", presentation };

    await deliverDraftPreview({
      payload,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledExactlyOnceWith(payload);
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("reports a final already published in a sealed preview generation", async () => {
    const draftStream = createDraftStreamMock(null);
    const deliverFinal = createDeliverFinalMock();
    const confirmedDelivery = createConfirmedPreviewDelivery("sealed-post-1", "Already visible");

    const result = await deliverDraftPreview({
      payload: { text: "Already visible" },
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({
        alreadyDelivered: true,
        confirmedDelivery,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "text",
      messageIds: ["sealed-post-1"],
      visibleReplySent: true,
      content: "Already visible",
    });
  });

  it("delivers unsent presentation controls after preview text was already published", async () => {
    const draftStream = createDraftStreamMock(null);
    const deliverFinal = createDeliverFinalMock();
    const confirmedDelivery = createConfirmedPreviewDelivery("sealed-post-1", "Already visible");
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };

    const result = await deliverDraftPreview({
      payload: { text: "Already visible", presentation },
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({ alreadyDelivered: true, confirmedDelivery }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({ text: "", presentation });
    expect(result.messageIds).toEqual(["sealed-post-1", "delivered-post-1"]);
  });

  it("still delivers media when the text is already published", async () => {
    const draftStream = createDraftStreamMock(null);
    const confirmedDelivery = createConfirmedPreviewDelivery("sealed-post-1", "Already visible");
    const mediaReceipt = createMattermostReceipt("media-post-1", "media");
    const deliverFinal = vi.fn(async () => ({
      outcome: "media" as const,
      messageIds: ["media-post-1"],
      receipt: mediaReceipt,
      visibleReplySent: true,
      content: "",
    }));

    const result = await deliverDraftPreview({
      payload: { text: "Already visible", mediaUrl: "https://example.com/image.png" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({
        alreadyDelivered: true,
        confirmedDelivery,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({
      text: "",
      mediaUrl: "https://example.com/image.png",
    });
    expect(result).toMatchObject({
      outcome: "media",
      messageIds: ["sealed-post-1", "media-post-1"],
      visibleReplySent: true,
      content: "Already visible",
    });
  });

  it("keeps a finalized preview after a later warning when participation failed", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const previewLifecycle = createPreviewLifecycle(draftStream);
    const recordThreadParticipation = vi.fn(async () => {});
    recordThreadParticipation.mockRejectedValueOnce(new Error("participation failed"));
    const params = {
      kind: "direct" as const,
      client: createMattermostClientMock(),
      resolvePreviewFinalText,
      previewLifecycle,
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
      recordThreadParticipation,
    };

    const firstDelivery = deliverMattermostReplyWithDraftPreview({
      ...params,
      payload: { text: "Successful assistant final" } as never,
      info: { kind: "final" },
    });
    await expect(firstDelivery).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["patched"],
        visibleReplySent: true,
        content: "Successful assistant final",
      },
    });
    await deliverMattermostReplyWithDraftPreview({
      ...params,
      payload: { text: "Tool error warning", isError: true } as never,
      info: { kind: "final" },
    });

    await previewLifecycle.cleanup();
    expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({
      text: "Tool error warning",
      isError: true,
    });
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("preserves a completed normal send when preview cleanup fails", async () => {
    const draftStream = createDraftStreamMock();
    draftStream.clear.mockRejectedValueOnce(new Error("preview cleanup failed"));
    const deliverFinal = createDeliverFinalMock();

    const result = await deliverDraftPreview({
      payload: { text: "Already visible", replyToId: "reply-1" } as never,
      draftStream,
      deliverPayload: deliverFinal,
    });

    expect(result).toMatchObject({
      messageIds: ["delivered-post-1"],
      visibleReplySent: true,
      content: "Already visible",
    });
    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview and sends media-only for TTS supplement finals", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();

    await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
      message: "Spoken answer",
    });
    expect(draftStream.discardPending).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(deliverFinal).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
  });

  it("retries an explicitly unsent TTS supplement through normal delivery", async () => {
    const draftStream = createDraftStreamMock();
    let deliveryAttempt = 0;
    const deliverFinal = vi.fn(async (payload: { text?: string }) => {
      deliveryAttempt += 1;
      if (deliveryAttempt === 1) {
        return {
          outcome: "empty" as const,
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" as const },
        };
      }
      return {
        outcome: "text" as const,
        messageIds: ["supplement-post-1"],
        receipt: createMattermostReceipt("supplement-post-1", "media"),
        visibleReplySent: true,
        content: payload.text ?? "",
      };
    });

    const result = await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledTimes(2);
    expect(deliverFinal.mock.calls[1]?.[0]).not.toHaveProperty("text");
    expect(result).toMatchObject({
      messageIds: ["patched", "supplement-post-1"],
      visibleReplySent: true,
      content: "Spoken answer",
    });
  });

  it("preserves the finalized preview receipt when its supplement fails after sending", async () => {
    const draftStream = createDraftStreamMock();
    const mediaReceipt = createMattermostReceipt("media-post-1", "media");
    const deliverFinal = vi.fn(async () => {
      throw createChannelPartialDeliveryError(new Error("supplement bookkeeping failed"), {
        messageIds: ["media-post-1"],
        receipt: mediaReceipt,
        visibleReplySent: true,
        content: "",
      });
    });

    let caught: unknown;
    try {
      await deliverDraftPreview({
        payload: {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        } as never,
        draftStream,
        effectiveReplyToId: "thread-root-1",
        deliverPayload: deliverFinal,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial Mattermost preview delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["patched", "media-post-1"],
      visibleReplySent: true,
      content: "Spoken answer",
    });
  });

  it("falls back with visible text when TTS supplement preview finalization fails", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    updateMattermostPostSpy.mockRejectedValueOnce(new Error("edit failed"));

    await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => ({
        editText: text?.trim(),
        deliveryText: "",
        alreadyDelivered: false,
      }),
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverFinal).toHaveBeenCalledWith({
      text: "Spoken answer",
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
  });
});
