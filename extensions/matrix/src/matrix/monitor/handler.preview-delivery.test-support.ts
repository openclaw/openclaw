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
      opts: GetReplyOptions;
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
  function expectVisible(result: unknown, messageIds: string[], content: string) {
    expect(result).toMatchObject({ messageIds, visibleReplySent: true, content });
  }
  async function showPreview(opts: GetReplyOptions, text: string, count: number) {
    await opts.onPartialReply?.({ text });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(count);
    });
  }
  async function startPreview(text = "Visible preview", previewToolProgressEnabled = false) {
    const context = createStreamingHarness({ streaming: "partial", previewToolProgressEnabled });
    const turn = await context.dispatch();
    try {
      await showPreview(turn.opts, text, 1);
    } catch (error) {
      await turn.finish();
      throw error;
    }
    return { ...context, ...turn };
  }
  it("retires a preview after source delivery and ignores late progress", async () => {
    const { redactEventMock, opts, finish } = await startPreview("Visible preview", true);
    try {
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

  it("retains a visible draft when media replacement reports no visible event", async () => {
    const { redactEventMock, deliver, finish } = await startPreview();
    deliverMatrixRepliesMock.mockResolvedValueOnce({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });

    const result = await deliver({ mediaUrl: "https://example.com/image.png" }, { kind: "final" });
    await finish();

    expectVisible(result, ["$draft1"], "Visible preview");
    expect(redactEventMock).not.toHaveBeenCalled();
  });

  it("combines a visible draft with accepted final-edit replacement prefixes", async () => {
    const { redactEventMock, deliver, finish } = await startPreview();
    editMessageMatrixMock.mockRejectedValueOnce(new Error("final edit failed"));
    deliverMatrixRepliesMock.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("second replacement event failed"), {
        ...createMockMatrixDeliveryResult("$accepted-prefix", "Accepted prefix"),
        visibleReplySent: true as const,
      }),
    );

    const error = await deliver({ text: "Final text" }, { kind: "final" }).catch(
      (caught: unknown) => caught,
    );

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
  });

  it("preserves accepted replacement receipts and retries failed preview redaction", async () => {
    const { redactEventMock, deliver, finish } = await startPreview();
    redactEventMock.mockRejectedValueOnce(new Error("redaction failed"));

    const result = await deliver({ text: "Something failed", isError: true }, { kind: "final" });

    expectVisible(result, ["$draft1", "$reply1"], "Visible preview\ndelivered");
    deliverMatrixRepliesMock.mockResolvedValueOnce(
      createMockMatrixDeliveryResult("$reply2", "Later durable reply"),
    );
    const laterResult = await deliver({ text: "Later durable reply" }, { kind: "final" });
    expectVisible(laterResult, ["$reply2"], "Later durable reply");
    expect(editMessageMatrixMock).not.toHaveBeenCalled();
    await finish();
    expect(mockCalls(redactEventMock, "redactEvent").map(([, id]) => id)).toEqual([
      "$draft1",
      "$draft1",
    ]);
  });

  it.each(["block", "followup"] as const)(
    "settles retained/unfinished block or consumed/complete followup generations: %s",
    async (boundary) => {
      const retained = boundary === "block";
      const { redactEventMock, deliver, onError, opts, finish } =
        await startPreview("First generation");
      if (retained) {
        deliverMatrixRepliesMock.mockRejectedValueOnce(new Error("replacement failed"));
      }
      if (boundary === "block") {
        await opts.onBlockReplyQueued?.({ text: "First generation" });
      }
      const firstDelivery = deliver(
        { text: "First replacement", isError: true },
        { kind: boundary === "block" ? "block" : "final" },
      );
      if (retained) {
        await firstDelivery.catch(() => undefined);
      } else {
        await firstDelivery;
      }
      if (boundary === "followup") {
        await opts.onQueuedFollowupAdmitted?.();
      } else {
        onError(new Error("replacement failed"), { kind: "block" });
        await opts.onAssistantMessageStart?.();
      }

      sendSingleTextMessageMatrixMock.mockResolvedValueOnce({
        messageId: "$draft2",
        roomId: "!room",
      });
      await showPreview(opts, "Next generation", 2);
      if (!retained) {
        await deliver({ text: "Second replacement", isError: true }, { kind: "final" });
      }
      await finish();

      const redactedEventIds = mockCalls(redactEventMock, "redactEvent").map(
        ([, eventId]) => eventId,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft1")).toHaveLength(
        retained ? 0 : 1,
      );
      expect(redactedEventIds.filter((eventId) => eventId === "$draft2")).toHaveLength(1);
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(retained ? 1 : 2);
      if (!retained) {
        expect(deliverMatrixRepliesMock.mock.invocationCallOrder[1]).toBeLessThan(
          redactEventMock.mock.invocationCallOrder.at(-1)!,
        );
      }
    },
  );
}
