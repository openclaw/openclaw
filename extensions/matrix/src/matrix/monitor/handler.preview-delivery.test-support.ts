import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, type Mock } from "vitest";
import type { MatrixReplyDeliveryResult } from "./replies.js";

type PreviewDeliveryHarness = {
  createStreamingHarness: (options: {
    streaming: "partial";
    previewToolProgressEnabled?: boolean;
  }) => {
    dispatch: () => Promise<{
      deliver: (payload: ReplyPayload, info: { kind: string }) => Promise<unknown>;
      onError: (error: unknown, info: { kind: string }) => void;
      opts: Pick<
        GetReplyOptions,
        | "onPartialReply"
        | "onItemEvent"
        | "onObservedReplyDelivery"
        | "onBlockReplyQueued"
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
  ) => MatrixReplyDeliveryResult;
  sendSingleTextMessageMatrixMock: Mock;
  editMessageMatrixMock: Mock;
  deliverMatrixRepliesMock: Mock;
  waitForMatrixState: (assertion: () => void) => Promise<void>;
  mockCalls: (mock: unknown, label: string) => unknown[][];
};

export function registerMatrixPreviewDeliveryTests(harness: PreviewDeliveryHarness) {
  const {
    createStreamingHarness,
    createMockMatrixDeliveryResult,
    sendSingleTextMessageMatrixMock,
    editMessageMatrixMock,
    deliverMatrixRepliesMock,
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
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();
  });

  it("preserves a surviving draft receipt when redaction and media delivery fail", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    await opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("media send failed"));
    const error = await deliver(
      { mediaUrl: "https://example.com/image.png" },
      { kind: "final" },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it("preserves a surviving draft receipt when final-edit fallback also fails", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    await opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));
    const error = await deliver({ text: "Final text" }, { kind: "final" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it("preserves a surviving draft receipt when generic fallback delivery fails", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    await opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("fallback send failed"));
    const error = await deliver({ text: "Something failed", isError: true } as never, {
      kind: "final",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
        receipt: { primaryPlatformMessageId: "$draft1" },
      },
    });
    await finish();
  });

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])("retains a visible draft when $branch replacement throws", async ({ payload, failEdit }) => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    await opts.onPartialReply?.({ text: "Visible preview" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    if (failEdit) {
      editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
    }
    deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("replacement failed"));

    const error = await deliver(payload, { kind: "final" }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
      },
    });
    expect(redactEventMock).not.toHaveBeenCalled();
    await finish();
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "retains a visible draft when $branch replacement reports no visible event",
    async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }
      deliverMatrixRepliesMock.mockResolvedValueOnce({
        visibleReplySent: false,
        suppression: { reason: "no_visible_result" },
      });

      const result = await deliver(payload, { kind: "final" });
      await finish();

      expect(result).toMatchObject({
        messageIds: ["$draft1"],
        visibleReplySent: true,
        content: "Visible preview",
      });
      expect(redactEventMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "redacts a visible draft only after complete $branch replacement",
    async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }

      const result = await deliver(payload, { kind: "final" });

      expect(result).toMatchObject({ messageIds: ["$reply1"], visibleReplySent: true });
      expect(deliverMatrixRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
        redactEventMock.mock.invocationCallOrder[0]!,
      );
      expect(redactEventMock).toHaveBeenCalledExactlyOnceWith("!room:example.org", "$draft1");
      await finish();
      expect(redactEventMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { branch: "final-edit", payload: { text: "Final text" }, failEdit: true },
    { branch: "media", payload: { mediaUrl: "https://example.com/image.png" }, failEdit: false },
    { branch: "generic", payload: { text: "Something failed", isError: true }, failEdit: false },
  ])(
    "combines a visible draft with accepted $branch replacement prefixes",
    async ({ payload, failEdit }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "Visible preview" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (failEdit) {
        editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
      }
      deliverMatrixRepliesMock.mockRejectedValueOnce(
        createChannelPartialDeliveryError(new Error("second replacement event failed"), {
          ...createMockMatrixDeliveryResult("$accepted-prefix", "Accepted prefix"),
          visibleReplySent: true as const,
        }),
      );

      const error = await deliver(payload, { kind: "final" }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
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
    },
  );

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
    deliverMatrixRepliesMock.mockResolvedValueOnce(
      createMockMatrixDeliveryResult("$reply2", "Later durable reply"),
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

  it.each(
    (["retained", "consumed"] as const).flatMap((priorDisposition) =>
      (["block", "followup"] as const).flatMap((boundary) =>
        (["complete", "unfinished"] as const).map((outcome) => ({
          priorDisposition,
          boundary,
          outcome,
        })),
      ),
    ),
  )(
    "settles $priorDisposition then $boundary draft generations through $outcome",
    async ({ priorDisposition, boundary, outcome }) => {
      const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
      const { deliver, onError, opts, finish } = await dispatch();

      await opts.onPartialReply?.({ text: "First generation" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });
      if (priorDisposition === "retained") {
        deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("replacement failed"));
      }
      if (boundary === "block") {
        await opts.onBlockReplyQueued?.({ text: "First generation" });
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
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(outcome === "complete" ? 2 : 1);
      if (outcome === "complete") {
        expect(deliverMatrixRepliesMock.mock.invocationCallOrder[1]).toBeLessThan(
          redactEventMock.mock.invocationCallOrder.at(-1)!,
        );
      }
    },
  );
}
