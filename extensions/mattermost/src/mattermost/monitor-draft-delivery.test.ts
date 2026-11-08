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
import { beforeEach, expect, it, vi } from "vitest";
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

function createDeliveryResult(
  messageId: string,
  content = "",
  kind: "text" | "preview" | "media" = "preview",
) {
  const outcome = kind === "media" ? ("media" as const) : ("text" as const);
  return {
    outcome,
    messageIds: [messageId],
    receipt: createMattermostReceipt(messageId, kind),
    visibleReplySent: true,
    content,
  };
}

const visible = (messageIds: string[], content: string, outcome?: "text" | "media") => ({
  messageIds,
  visibleReplySent: true,
  content,
  ...(outcome ? { outcome } : {}),
});

type DraftStreamMock = ReturnType<typeof createDraftStreamMock>;

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
  return vi.fn(async (payload: { text?: string }) =>
    createDeliveryResult("delivered-post-1", payload.text ?? "", "text"),
  );
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

let draftStream: ReturnType<typeof createDraftStreamMock>;
let deliverFinal: ReturnType<typeof createDeliverFinalMock>;
const nativeControls = () => ({
  blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
});
const ttsPayload = () => ({
  mediaUrl: "https://example.com/tts.mp3",
  audioAsVoice: true,
  spokenText: "Spoken answer",
  ttsSupplement: { spokenText: "Spoken answer" },
});

function deliverDraftPreview(
  payload: ReplyPayload,
  params: Partial<Omit<DraftDeliveryParams, "payload">> = {},
) {
  return deliverMattermostReplyWithDraftPreview({
    payload,
    info: { kind: "final" },
    kind: "channel",
    client: createMattermostClientMock(),
    resolvePreviewFinalText,
    previewLifecycle: createPreviewLifecycle(draftStream),
    effectiveReplyToId: "thread-root-1",
    deliverPayload: deliverFinal,
    logVerboseMessage: vi.fn(),
    ...params,
  });
}

function deliverPublished(
  extra: Partial<ReplyPayload> = {},
  options: Partial<DraftDeliveryParams> = {},
) {
  draftStream = createDraftStreamMock(null);
  return deliverDraftPreview(
    { text: "Already visible", ...extra },
    {
      resolvePreviewFinalText: () => ({
        alreadyDelivered: true,
        confirmedDelivery: createDeliveryResult("sealed-post-1", "Already visible"),
      }),
      ...options,
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  draftStream = createDraftStreamMock();
  deliverFinal = createDeliverFinalMock();
  updateMattermostPostSpy.mockResolvedValue({ id: "patched" } as never);
});

it("suppresses reasoning-prefixed finals before preview finalization", async () => {
  const recordThreadParticipation = vi.fn();
  await deliverDraftPreview(
    { text: "  \n > Reasoning:\n> _hidden_" },
    { recordThreadParticipation },
  );

  expect(deliverFinal).not.toHaveBeenCalled();
  expect(draftStream.flush).not.toHaveBeenCalled();
  expect(draftStream.discardPending).not.toHaveBeenCalled();
  expect(draftStream.clear).not.toHaveBeenCalled();
  expect(updateMattermostPostSpy).not.toHaveBeenCalled();
  expect(recordThreadParticipation).not.toHaveBeenCalled();
});

it("records thread participation when a same-thread final finalizes the preview in place", async () => {
  const recording = createDeferred<void>();
  const registered = createDeferred<void>();
  const recordThreadParticipation = vi.fn(() => {
    recording.resolve();
    return registered.promise;
  });
  let settled = false;

  const delivery = deliverDraftPreview({ text: "All good" }, { recordThreadParticipation }).finally(
    () => {
      settled = true;
    },
  );
  try {
    await recording.promise;
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    registered.resolve();
    await delivery;
  }
  const result = await delivery;

  // Preview edits bypass deliverPayload; participation must still settle (PR #95552).
  expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
    message: "All good",
  });
  expect(deliverFinal).not.toHaveBeenCalled();
  expect(draftStream.seal).toHaveBeenCalledTimes(1);
  expect(draftStream.seal.mock.invocationCallOrder[0]).toBeLessThan(
    updateMattermostPostSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
  expect(recordThreadParticipation).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject(visible(["patched"], "All good", "text"));
});

it("delivers native value buttons instead of losing them in a preview edit", async () => {
  const presentation = nativeControls();
  const payload = { text: "Choose an option", presentation };

  await deliverDraftPreview(payload);

  expect(deliverFinal).toHaveBeenCalledExactlyOnceWith(payload);
  expect(updateMattermostPostSpy).not.toHaveBeenCalled();
  expect(draftStream.clear).toHaveBeenCalledTimes(1);
});

it("reports a final already published in a sealed preview generation", async () => {
  const result = await deliverPublished();

  expect(deliverFinal).not.toHaveBeenCalled();
  expect(result).toMatchObject(visible(["sealed-post-1"], "Already visible", "text"));
});

it("delivers unsent presentation controls after preview text was already published", async () => {
  const presentation = nativeControls();
  const result = await deliverPublished({ presentation });

  expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({ text: "", presentation });
  expect(result.messageIds).toEqual(["sealed-post-1", "delivered-post-1"]);
});

it("still delivers media when the text is already published", async () => {
  const deliverPayload = vi.fn(async () => createDeliveryResult("media-post-1", "", "media"));

  const result = await deliverPublished(
    { mediaUrl: "https://example.com/image.png" },
    { deliverPayload },
  );

  expect(deliverPayload).toHaveBeenCalledExactlyOnceWith({
    text: "",
    mediaUrl: "https://example.com/image.png",
  });
  expect(result).toMatchObject(
    visible(["sealed-post-1", "media-post-1"], "Already visible", "media"),
  );
});

it("keeps a finalized preview after a later warning when participation failed", async () => {
  const previewLifecycle = createPreviewLifecycle(draftStream);
  const recordThreadParticipation = vi.fn(async () => {});
  recordThreadParticipation.mockRejectedValueOnce(new Error("participation failed"));
  const params = {
    kind: "direct" as const,
    previewLifecycle,
    effectiveReplyToId: undefined,
    recordThreadParticipation,
  };

  const firstDelivery = deliverDraftPreview({ text: "Successful assistant final" }, params);
  await expect(firstDelivery).rejects.toMatchObject({
    code: "CHANNEL_PARTIAL_DELIVERY",
    deliveryResult: visible(["patched"], "Successful assistant final"),
  });
  await deliverDraftPreview({ text: "Tool error warning", isError: true }, params);

  await previewLifecycle.cleanup();
  expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({
    text: "Tool error warning",
    isError: true,
  });
  expect(draftStream.clear).not.toHaveBeenCalled();
});

it("preserves a completed normal send when preview cleanup fails", async () => {
  draftStream.clear.mockRejectedValueOnce(new Error("preview cleanup failed"));

  const result = await deliverDraftPreview(
    { text: "Already visible", replyToId: "reply-1" },
    { effectiveReplyToId: undefined },
  );

  expect(result).toMatchObject(visible(["delivered-post-1"], "Already visible"));
  expect(deliverFinal).toHaveBeenCalledTimes(1);
  expect(draftStream.clear).toHaveBeenCalledTimes(1);
});

it("keeps the preview and sends media-only for TTS supplement finals", async () => {
  await deliverDraftPreview(ttsPayload());

  expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
    message: "Spoken answer",
  });
  expect(draftStream.discardPending).not.toHaveBeenCalled();
  expect(draftStream.clear).not.toHaveBeenCalled();
  expect(deliverFinal).toHaveBeenCalledWith(ttsPayload());
});

it("retries an explicitly unsent TTS supplement through normal delivery", async () => {
  const deliverPayload = vi
    .fn<DraftDeliveryParams["deliverPayload"]>(async (payload) => ({
      ...createDeliveryResult("supplement-post-1", payload.text ?? "", "media"),
      outcome: "text" as const,
    }))
    .mockResolvedValueOnce({
      outcome: "empty",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });

  const result = await deliverDraftPreview(ttsPayload(), { deliverPayload });

  expect(deliverPayload).toHaveBeenCalledTimes(2);
  expect(deliverPayload.mock.calls[1]?.[0]).not.toHaveProperty("text");
  expect(result).toMatchObject(visible(["patched", "supplement-post-1"], "Spoken answer"));
});

it("preserves the finalized preview receipt when its supplement fails after sending", async () => {
  const mediaReceipt = createMattermostReceipt("media-post-1", "media");
  const deliverPayload = vi.fn(async () => {
    throw createChannelPartialDeliveryError(new Error("supplement bookkeeping failed"), {
      messageIds: ["media-post-1"],
      receipt: mediaReceipt,
      visibleReplySent: true,
      content: "",
    });
  });

  const delivery = deliverDraftPreview(ttsPayload(), { deliverPayload });
  await expect(delivery).rejects.toSatisfy(isChannelPartialDeliveryError);
  await expect(delivery).rejects.toMatchObject({
    deliveryResult: visible(["patched", "media-post-1"], "Spoken answer"),
  });
});

it("falls back with visible text when TTS supplement preview finalization fails", async () => {
  updateMattermostPostSpy.mockRejectedValueOnce(new Error("edit failed"));
  await deliverDraftPreview(ttsPayload(), {
    resolvePreviewFinalText: (text) => ({
      editText: text?.trim(),
      deliveryText: "",
      alreadyDelivered: false,
    }),
  });

  expect(updateMattermostPostSpy).toHaveBeenCalledTimes(1);
  expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
  expect(draftStream.clear).toHaveBeenCalledTimes(1);
  expect(deliverFinal).toHaveBeenCalledWith({ ...ttsPayload(), text: "Spoken answer" });
});
