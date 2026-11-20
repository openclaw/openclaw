import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { LivePreviewDeliveryResult } from "openclaw/plugin-sdk/channel-outbound";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi, type Mock } from "vitest";
import type { MatrixConfig } from "../../types.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";
import type { MatrixReplyDispatchInfo } from "./handler-draft-controller.js";

type PreviewDeliveryHarness = {
  createStreamingHarness: (options: {
    streaming: "partial" | "quiet" | "progress";
    previewToolProgressEnabled?: boolean;
    blockStreamingEnabled?: boolean;
    accountConfig?: MatrixConfig;
  }) => {
    dispatch: () => Promise<{
      deliver: (payload: ReplyPayload, info: MatrixReplyDispatchInfo) => Promise<unknown>;
      onError: (error: unknown, info: { kind: string }) => void;
      opts: Pick<
        GetReplyOptions,
        | "onPartialReply"
        | "onItemEvent"
        | "onObservedReplyDelivery"
        | "onQueuedFollowupAdmitted"
        | "onAssistantMessageStart"
      >;
      finish: () => Promise<void>;
    }>;
    redactEventMock: Mock;
  };
  createMockMatrixDeliveryResult: (
    messageId?: string,
    content?: string,
  ) => LivePreviewDeliveryResult;
  acceptMatrixReply: (
    messageId?: string,
    content?: string,
  ) => typeof import("../send.js").sendMessageMatrix;
  sendSingleTextMessageMatrixMock: Mock;
  editMessageMatrixMock: Mock;
  sendMessageMatrixMock: Mock<typeof import("../send.js").sendMessageMatrix>;
  waitForMatrixState: (assertion: () => void) => Promise<void>;
  mockCalls: (mock: unknown, label: string) => unknown[][];
};

export function registerMatrixPreviewDeliveryTests(harness: PreviewDeliveryHarness) {
  const {
    createStreamingHarness,
    createMockMatrixDeliveryResult,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    sendMessageMatrixMock,
    acceptMatrixReply,
    waitForMatrixState,
    mockCalls,
  } = harness;
  it("retires a preview after source delivery and ignores late progress", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      streaming: "partial",
      previewToolProgressEnabled: true,
    });
    const { opts, finish } = await dispatch();
    try {
      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      await opts.onObservedReplyDelivery?.();
      await opts.onPartialReply?.({ text: "Late model delta" });
      await opts.onItemEvent?.({
        itemId: "late-tool",
        kind: "tool",
        name: "exec",
        status: "running",
        progressText: "late progress",
      });
    } finally {
      await finish();
    }
    expect(redactEventMock).toHaveBeenCalledExactlyOnceWith("!room:example.org", "$draft1");
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
  });

  it("retains a visible draft when a reasoning replacement is suppressed", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();
    await opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    const result = await deliver(
      { mediaUrl: "https://example.com/image.png", isReasoning: true },
      { kind: "final" },
    );
    await finish();
    expect(result).toMatchObject({
      messageIds: ["$draft1"],
      visibleReplySent: true,
      content: "Visible preview",
    });
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it("combines a visible draft with accepted replacement prefixes after a failed final edit", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();
    await opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
    sendMessageMatrixMock.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("second replacement event failed"), {
        ...createMockMatrixDeliveryResult("$accepted-prefix", "Accepted prefix"),
        visibleReplySent: true as const,
      }),
    );
    await expect(deliver({ text: "Final text" }, { kind: "final" })).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1", "$accepted-prefix"],
        visibleReplySent: true,
        content: "Visible preview\nAccepted prefix",
      },
    });
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it("preserves accepted replacement receipts and retries failed preview redaction", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    await opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));

    const result = await deliver({ text: "Something failed", isError: true }, { kind: "final" });

    expect(result).toMatchObject({
      messageIds: ["$draft1", "$reply1"],
      visibleReplySent: true,
      content: "Visible preview\ndelivered",
    });
    sendMessageMatrixMock.mockImplementationOnce(
      acceptMatrixReply("$reply2", "Later durable reply"),
    );
    const laterResult = await deliver({ text: "Later durable reply" }, { kind: "final" });
    expect(laterResult).toMatchObject({
      messageIds: ["$reply2"],
      visibleReplySent: true,
      content: "Later durable reply",
    });
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
    expect(mockCalls(redactEventMock, "redactEvent").map(([, id]) => id)).toEqual([
      "$draft1",
      "$draft1",
    ]);
  });

  it.each([false, true])(
    "does not replay a retained preview after block delivery fails (newer message: %s)",
    async (newerMessage) => {
      const { dispatch, redactEventMock } = createStreamingHarness({
        streaming: "partial",
        blockStreamingEnabled: true,
      });
      const { deliver, onError, opts, finish } = await dispatch();
      await opts.onAssistantMessageStart?.();
      if (newerMessage) {
        await opts.onAssistantMessageStart?.();
      }
      const preview = newerMessage ? "Beta\n\nGamma" : "Alpha\n\nBeta\n\nGamma";
      await opts.onPartialReply?.({ text: preview });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      sendMessageMatrixMock.mockRejectedValueOnce(new Error("replacement failed"));
      const info = {
        kind: "block",
        assistantMessageIndex: 1,
        blockSourceRange: [0, 7],
      } satisfies MatrixReplyDispatchInfo;
      await expect(deliver({ text: "Alpha" }, info)).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: { visibleReplySent: true, content: preview },
      });
      onError(new Error("replacement failed"), info);
      await deliver(
        { text: "Beta" },
        {
          kind: "block",
          assistantMessageIndex: newerMessage ? 2 : 1,
          blockSourceRange: newerMessage ? [0, 6] : [7, 13],
        },
      );
      await finish();
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      expect(redactEventMock).not.toHaveBeenCalled();
    },
  );

  it("advances source boundaries in order while Matrix deliveries drain", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({
      streaming: "quiet",
      blockStreamingEnabled: true,
    });
    const { deliver, opts, finish } = await dispatch();
    await opts.onAssistantMessageStart?.();
    await opts.onPartialReply?.({ text: "Alpha" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    await opts.onPartialReply?.({ text: "Alpha\n\nBeta\n\nGamma" });

    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft2",
      roomId: "!room",
    });
    await deliver(
      { text: "Alpha" },
      { kind: "block", assistantMessageIndex: 1, blockSourceRange: [0, 7] },
    );
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock.mock.lastCall?.[1]).toBe("Beta\n\nGamma");
    });
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft1",
      "Alpha",
      expect.objectContaining({ extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true } }),
    );

    sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
      messageId: "$draft3",
      roomId: "!room",
    });
    await deliver(
      { text: "Beta" },
      { kind: "block", assistantMessageIndex: 1, blockSourceRange: [7, 13] },
    );
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock.mock.lastCall?.[1]).toBe("Gamma");
    });
    expect(editMessageMatrixMock).toHaveBeenCalledWith(
      "!room:example.org",
      "$draft2",
      "Beta",
      expect.objectContaining({ extraContent: { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true } }),
    );
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
  });

  it.each([
    { priorDisposition: "retained", boundary: "block", outcome: "unfinished" },
    { priorDisposition: "consumed", boundary: "followup", outcome: "complete" },
  ] as const)(
    "settles $priorDisposition then $boundary draft generations through $outcome",
    async ({ priorDisposition, boundary, outcome }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, onError, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "First generation" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (priorDisposition === "retained") {
        sendMessageMatrixMock.mockRejectedValueOnce(new Error("replacement failed"));
      }
      const firstDelivery = deliver(
        { text: "First replacement", isError: true },
        { kind: boundary === "block" ? "block" : "final" },
      );
      if (priorDisposition === "retained") {
        await firstDelivery.catch(() => undefined);
      } else {
        await firstDelivery;
      }
      if (boundary === "followup") {
        await opts.onQueuedFollowupAdmitted?.();
      } else {
        if (priorDisposition === "retained") {
          onError(new Error("replacement failed"), { kind: "block" });
        }
        await opts.onAssistantMessageStart?.();
      }

      sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
        messageId: "$draft2",
        roomId: "!room",
      });
      await opts.onPartialReply?.({ text: "Next generation" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(2);
      });
      if (outcome === "complete") {
        await deliver({ text: "Second replacement", isError: true }, { kind: "final" });
      }
      await finish();

      const redactedEventIds = mockCalls(redactEventMock, "redactEvent").map(
        ([, eventId]) => eventId,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft1")).toHaveLength(
        priorDisposition === "consumed" ? 1 : 0,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft2")).toHaveLength(1);
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(outcome === "complete" ? 2 : 1);
      if (outcome === "complete") {
        expect(sendMessageMatrixMock.mock.invocationCallOrder[1]).toBeLessThan(
          redactEventMock.mock.invocationCallOrder.at(-1)!,
        );
      }
    },
  );

  it("keeps truncated tool progress UTF-16 safe and captions the final image", async () => {
    vi.useFakeTimers();
    const { dispatch, redactEventMock } = createStreamingHarness({
      streaming: "progress",
      previewToolProgressEnabled: true,
      accountConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, label: false, maxLineChars: 500 },
        },
      },
    });
    const { opts, deliver, finish } = await dispatch();
    const progressPrefix = "x".repeat(298);
    const progressText = `${progressPrefix}🎉tail`;
    await opts.onItemEvent?.({ progressText });
    await opts.onItemEvent?.({ progressText });
    expect(sendSingleTextMessageMatrixMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendSingleTextMessageMatrixMock.mock.lastCall?.[1]).toBe(`- \`${progressPrefix}...\``);
    sendMessageMatrixMock.mockClear();
    await deliver(
      { text: "Here is the image", mediaUrl: "https://example.com/image.png" },
      { kind: "final" },
    );
    expect(sendMessageMatrixMock).toHaveBeenCalledExactlyOnceWith(
      "!room:example.org",
      "Here is the image",
      expect.objectContaining({ mediaUrl: "https://example.com/image.png" }),
    );
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    await finish();
    vi.useRealTimers();
  });
}
