// Msteams tests cover reply stream controller plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { teamsQuotedTableReply } from "./format.test-fixtures.js";
import { flattenInformativeStatus } from "./informative-status.js";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

type StreamCloseResult = { id: string } | undefined;

function makeStream() {
  return {
    emit: vi.fn(),
    update: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn<() => Promise<StreamCloseResult>>(async () => ({ id: "stream-final" })),
    canceled: false,
  };
}

function makeAcknowledgedStream() {
  type ChunkActivity = {
    id?: string;
    type?: string;
    text?: string;
    channelData?: { streamType?: string };
  };
  const handlers = new Map<number, (activity: ChunkActivity) => void>();
  let nextSubscriptionId = 0;
  const stream = {
    ...makeStream(),
    events: {
      on: vi.fn((_event: "chunk", handler: (activity: ChunkActivity) => void) => {
        const subscriptionId = nextSubscriptionId++;
        handlers.set(subscriptionId, handler);
        return subscriptionId;
      }),
      off: vi.fn((subscriptionId: number) => {
        handlers.delete(subscriptionId);
      }),
    },
    acknowledge(text: string, overrides: Partial<ChunkActivity> = {}) {
      const activity: ChunkActivity = {
        id: "stream-acknowledged",
        type: "typing",
        text,
        channelData: { streamType: "streaming" },
        ...overrides,
      };
      for (const handler of handlers.values()) {
        handler(activity);
      }
    },
  };
  return stream;
}

function makeContext(stream?: ReturnType<typeof makeStream>) {
  return { activity: { type: "message" }, stream } as never;
}

function makeController(
  opts: {
    conversationType?: string;
    stream?: ReturnType<typeof makeStream>;
  } = {},
) {
  const stream = opts.stream;
  return createTeamsReplyStreamController({
    allowProviderPreview: true,
    conversationType: opts.conversationType ?? "personal",
    context: makeContext(stream),
    feedbackLoopEnabled: false,
  });
}

describe("createTeamsReplyStreamController", () => {
  it("emits only the delta when openclaw sends cumulative text on each chunk", () => {
    // openclaw's reply pipeline calls onPartialReply with the cumulative
    // text-so-far on every chunk. The SDK's HttpStream APPENDS each emit() to
    // its internal text buffer (this.text += activity.text). Without delta
    // conversion, the SDK accumulates "chunk1 + chunk2 + chunk3" and the user
    // sees the message duplicated on each progress update (real bug observed
    // 2026-05-06: a sonnet rendered with each line repeated alongside the
    // previous full state).
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "Here's one for you:\nThe morning" });
    ctrl.onPartialReply({ text: "Here's one for you:\nThe morning light" });
    ctrl.onPartialReply({ text: "Here's one for you:\nThe morning light breaks" });
    expect(stream.emit).toHaveBeenNthCalledWith(1, "Here's one for you:\nThe morning");
    expect(stream.emit).toHaveBeenNthCalledWith(2, " light");
    expect(stream.emit).toHaveBeenNthCalledWith(3, " breaks");
  });

  it("keeps the next chunk after cumulative trailing whitespace is normalized", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "Intro\n\n " });
    ctrl.onPartialReply({ text: "Intro\n\nNext" });

    expect(stream.emit).toHaveBeenNthCalledWith(1, "Intro\n\n ");
    expect(stream.emit).toHaveBeenNthCalledWith(2, "Next");
  });

  it("retains an acknowledged replacement when stream close produces no activity", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "provider replacement" });
    expect(
      ctrl.preparePayload({
        text: "provider replacement",
        mediaUrl: "https://example.test/replacement.png",
      }),
    ).toBeUndefined();
    stream.acknowledge("provider replacement");
    stream.close.mockResolvedValueOnce(undefined);

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-acknowledged",
      content: "provider replacement",
      logicalContent: "provider replacement",
      postNativePayloads: [
        {
          text: undefined,
          mediaUrl: "https://example.test/replacement.png",
        },
      ],
    });
  });

  it("falls back to the full replacement when close fails before acknowledgement", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "provider replacement" });
    expect(ctrl.preparePayload({ mediaUrl: "https://example.test/before.png" })).toBeUndefined();
    expect(
      ctrl.preparePayload({
        text: "provider replacement",
        mediaUrl: "https://example.test/replacement.png",
      }),
    ).toBeUndefined();
    stream.close.mockRejectedValueOnce(new Error("close failed"));

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-acknowledged",
      content: "abcde",
      logicalContent: "provider replacement",
      postNativePayloads: [
        { mediaUrl: "https://example.test/before.png" },
        {
          text: "provider replacement",
          mediaUrl: "https://example.test/replacement.png",
        },
      ],
    });
  });

  it("ignores a delayed old chunk that is only a prefix of the replacement", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "ab replacement" });
    expect(ctrl.preparePayload({ text: "ab replacement" })).toBeUndefined();
    stream.acknowledge("ab");
    stream.close.mockRejectedValueOnce(new Error("close failed"));

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-acknowledged",
      content: "abcde",
      logicalContent: "ab replacement",
      postNativePayloads: [{ text: "ab replacement" }],
    });
  });

  it("rejects a delayed common-prefix chunk while awaiting replacement acknowledgement", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcdef" });
    ctrl.onPartialReply({ text: "abcXYZ" });
    expect(ctrl.preparePayload({ text: "abcXYZ" })).toBeUndefined();
    stream.acknowledge("abc");
    stream.close.mockRejectedValueOnce(new Error("close failed"));

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: false,
      logicalContent: "abcXYZ",
      postNativePayloads: [{ text: "abcXYZ" }],
    });
  });

  it("uses the latest partial when no final text payload follows a rewrite", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "abXYZ" });
    ctrl.onPartialReply({ text: "abcdef" });
    expect(ctrl.preparePayload({ mediaUrl: "https://example.test/final.png" })).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-final",
      content: "abcdef",
      logicalContent: "abcdef",
      postNativePayloads: [{ mediaUrl: "https://example.test/final.png" }],
    });
    expect(stream.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "message", text: "abcdef" }),
    );
  });

  it("suppresses a replacement when emit synchronously discovers Stop", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "provider replacement" });
    stream.emit.mockImplementation(() => {
      const error = new Error("stream canceled");
      error.name = "StreamCancelledError";
      throw error;
    });

    expect(ctrl.preparePayload({ text: "provider replacement" })).toBeUndefined();
    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-acknowledged",
      content: "abcde",
    });
    expect(stream.close).not.toHaveBeenCalled();
  });

  it("holds payloads around replacement text until native settlement", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "provider replacement" });

    expect(ctrl.preparePayload({ mediaUrl: "https://example.test/before.png" })).toBeUndefined();
    expect(ctrl.preparePayload({ text: "provider replacement" })).toBeUndefined();
    expect(
      ctrl.preparePayload({
        text: "second payload",
        mediaUrl: "https://example.test/after.png",
      }),
    ).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-final",
      content: "provider replacement",
      logicalContent: "provider replacement\nsecond payload",
      postNativePayloads: [
        { mediaUrl: "https://example.test/before.png" },
        { text: "second payload", mediaUrl: "https://example.test/after.png" },
      ],
    });
  });

  it("preserves held payload order after replacement emit fails", async () => {
    const stream = makeAcknowledgedStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    stream.acknowledge("abcde");
    ctrl.onPartialReply({ text: "provider replacement" });
    expect(ctrl.preparePayload({ mediaUrl: "https://example.test/before.png" })).toBeUndefined();
    stream.emit.mockImplementationOnce(() => {
      throw new Error("network failure");
    });
    expect(ctrl.preparePayload({ text: "provider replacement" })).toBeUndefined();
    expect(ctrl.preparePayload({ text: "later payload" })).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-final",
      content: "abcde",
      logicalContent: "provider replacement\nlater payload",
      postNativePayloads: [
        { mediaUrl: "https://example.test/before.png" },
        { text: "provider replacement" },
        { text: "later payload" },
      ],
    });
  });

  it("ignores duplicate or out-of-order partial replies that don't extend the text", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "abcdef" });
    ctrl.onPartialReply({ text: "abc" }); // shorter — could be edit-in-place semantics
    ctrl.onPartialReply({ text: "abcdef" }); // back to known length
    expect(stream.emit).toHaveBeenCalledTimes(1);
    expect(stream.emit).toHaveBeenCalledWith("abcdef");
  });

  it("keeps replies without partial text or progress work on block delivery", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    expect(stream.update).not.toHaveBeenCalled();
    expect(stream.emit).not.toHaveBeenCalled();
    expect(ctrl.preparePayload({ text: "tool-only response" })).toEqual({
      text: "tool-only response",
    });
    await ctrl.finalize();
    expect(stream.close).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps later partial segments whole with settled=%s", async (settled) => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "First segment" });
    expect(ctrl.preparePayload({ text: "First segment" })).toBeUndefined();
    expect(ctrl.claimNativeDelivery()).toBe(true);
    if (settled) {
      await ctrl.finalize();
    }

    ctrl.onPartialReply({ text: "Second segment after tools" });
    const result = ctrl.preparePayload({ text: "Second segment after tools" });
    expect(result).toEqual({ text: "Second segment after tools" });
  });

  it("passes media+text payload through fully after stream finalization is pending", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "Streamed text" });
    expect(ctrl.preparePayload({ text: "Streamed text" })).toBeUndefined();

    expect(
      ctrl.preparePayload({
        text: "Post-tool text with image",
        mediaUrl: "https://example.com/tool-output.png",
      }),
    ).toEqual({
      text: "Post-tool text with image",
      mediaUrl: "https://example.com/tool-output.png",
    });
  });

  it("drops the payload even when it carries media after cancel", () => {
    // Cancel honored consistently — no leftover media bubble lands either.
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    expect(
      ctrl.preparePayload({ text: "partial complete", mediaUrl: "https://x/y.png" }),
    ).toBeUndefined();
  });

  it("preserves disabled quoted tables when finalizing formatted replies", async () => {
    const { source: text, expected } = teamsQuotedTableReply;
    const stream = makeStream();
    const ctrl = createTeamsReplyStreamController({
      allowProviderPreview: true,
      conversationType: "personal",
      context: makeContext(stream),
      feedbackLoopEnabled: false,
      tableMode: "off",
    });

    ctrl.onPartialReply({ text });
    expect(ctrl.preparePayload({ text })).toBeUndefined();
    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: true,
      messageId: "stream-final",
      content: expected,
      logicalContent: text,
    });
    expect(stream.clearText).toHaveBeenCalledTimes(1);
    expect(stream.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "message", text: expected }),
    );
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it("returns text-only fallback when stream close no-ops after media already queued", async () => {
    const stream = makeStream();
    stream.close.mockResolvedValueOnce(undefined);
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed final", mediaUrl: "https://x/y.png" })).toEqual({
      text: undefined,
      mediaUrl: "https://x/y.png",
    });

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: false,
      fallbackPayload: {
        text: "streamed final",
        mediaUrl: undefined,
        mediaUrls: undefined,
      },
    });
  });

  it("returns suppressed final payload when stream close throws", async () => {
    const stream = makeStream();
    stream.close.mockRejectedValueOnce(new Error("close failed"));
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed final" })).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({
      visibleReplySent: false,
      fallbackPayload: { text: "streamed final" },
    });
  });

  it("streams compact Teams progress lines when tool progress is enabled", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    try {
      const ctrl = createTeamsReplyStreamController({
        allowProviderPreview: true,
        conversationType: "personal",
        context: makeContext(stream),
        feedbackLoopEnabled: false,
        log: { debug: vi.fn() } as never,
        msteamsConfig: {
          streaming: {
            mode: "progress",
            progress: {
              toolProgress: true,
              label: "Working",
              maxLines: 3,
            },
          },
        } as never,
      });

      await ctrl.pushItemEvent({ itemId: "search", title: "tool: search", phase: "start" });
      await ctrl.pushItemEvent({ itemId: "exec", title: "tool: exec", phase: "start" });
      expect(stream.update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);

      // Teams renders informative updates as a single status line and drops
      // newlines, so rows are joined with a visible separator.
      expect(stream.update).toHaveBeenLastCalledWith("Working · tool: search · tool: exec");
      for (const [text] of stream.update.mock.calls) {
        expect(text).not.toMatch(/\n/u);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces Teams plan snapshots and keeps the explanation", async () => {
    const stream = makeStream();
    const ctrl = createTeamsReplyStreamController({
      allowProviderPreview: true,
      conversationType: "personal",
      context: makeContext(stream),
      feedbackLoopEnabled: false,
      msteamsConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: false } },
      } as never,
    });

    await ctrl.pushPlanProgress([{ step: "Inspect", status: "in_progress" }], {
      explanation: "Initial plan",
    });
    await ctrl.pushPlanProgress(
      [
        { step: "Inspect", status: "completed" },
        { step: "Patch", status: "in_progress" },
      ],
      { explanation: "Revised plan" },
    );

    expect(stream.update).toHaveBeenLastCalledWith("Revised plan · ✅ Inspect · ▸ Patch");
  });

  it("cancels the pending progress gate at finalize so no stale card posts after close", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    try {
      const ctrl = createTeamsReplyStreamController({
        allowProviderPreview: true,
        conversationType: "personal",
        context: makeContext(stream),
        feedbackLoopEnabled: false,
        log: { debug: vi.fn() } as never,
        msteamsConfig: {
          streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
        } as never,
      });

      // One work event schedules the delayed start; the turn finishes first.
      await ctrl.pushItemEvent({ itemId: "search", title: "tool: search", phase: "start" });
      ctrl.preparePayload({ text: "done" });
      await ctrl.finalize();
      expect(stream.update).not.toHaveBeenCalled();

      // The gate timer must be dead: firing it against the closed stream
      // would post a fresh stale "working" card below the final answer.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stream.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores progress after final answer streaming starts and settles", async () => {
    const stream = makeStream();
    const ctrl = createTeamsReplyStreamController({
      allowProviderPreview: true,
      conversationType: "personal",
      context: makeContext(stream),
      feedbackLoopEnabled: false,
      msteamsConfig: { streaming: { mode: "progress", progress: { toolProgress: true } } } as never,
    });

    expect(ctrl.preparePayload({ text: "complete final answer" })).toBeUndefined();
    await ctrl.pushPlanProgress([{ step: "Late plan", status: "in_progress" }]);
    const lateFailure = {
      itemId: "late-failure",
      title: "Late failure",
      phase: "end",
      status: "failed",
    };
    await ctrl.pushItemEvent(lateFailure);
    await ctrl.finalize();
    await ctrl.pushPlanProgress([{ step: "Late settled plan", status: "in_progress" }]);
    await ctrl.pushItemEvent(lateFailure);

    expect(stream.update).not.toHaveBeenCalled();
  });

  it("falls back to normal delivery when progress final streaming fails", () => {
    const stream = makeStream();
    stream.emit.mockImplementation(() => {
      throw new Error("progress final failed");
    });
    const ctrl = createTeamsReplyStreamController({
      allowProviderPreview: true,
      conversationType: "personal",
      context: makeContext(stream),
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: { streaming: { mode: "progress", progress: { toolProgress: true } } } as never,
    });

    expect(ctrl.preparePayload({ text: "complete final answer" })).toEqual({
      text: "complete final answer",
    });
  });

  describe("StreamCancelledError handling", () => {
    function makeCancelError(): Error {
      const err = new Error("stream canceled");
      err.name = "StreamCancelledError";
      return err;
    }

    it("swallows StreamCancelledError thrown from stream.emit (Stop button race)", () => {
      const stream = makeStream();
      stream.emit.mockImplementation(() => {
        throw makeCancelError();
      });
      const ctrl = makeController({ stream });
      // Must not throw — the SDK throws this synchronously when _canceled
      // flipped between our pre-check and the emit call (or when no pre-check
      // happens at all). An uncaught throw here crashes the gateway process
      // since it surfaces as an unhandled promise rejection in async paths.
      expect(() => ctrl.onPartialReply({ text: "after stop" })).not.toThrow();
    });

    it("swallows StreamCancelledError thrown from progress stream.update", async () => {
      const stream = makeStream();
      stream.update.mockImplementation(() => {
        throw makeCancelError();
      });
      const ctrl = createTeamsReplyStreamController({
        allowProviderPreview: true,
        conversationType: "personal",
        context: makeContext(stream),
        feedbackLoopEnabled: false,
        msteamsConfig: {
          streaming: { mode: "progress", progress: { toolProgress: true } },
        } as never,
      });
      await ctrl.pushItemEvent({
        itemId: "tool:exec",
        name: "exec",
        title: "Exec",
        phase: "end",
        status: "failed",
      });
      expect(stream.update).toHaveBeenCalled();
    });

    it("swallows StreamCancelledError thrown from stream.emit during finalize", async () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "partial" });
      expect(ctrl.preparePayload({ text: "partial" })).toBeUndefined();
      // Cancel after we've started streaming, then make the final emit throw.
      stream.emit.mockImplementation(() => {
        throw makeCancelError();
      });
      // Must not throw — finalize's pre-check on stream.canceled may miss
      // the cancellation that happens between check and emit.
      await expect(ctrl.finalize()).resolves.toEqual({
        visibleReplySent: false,
      });
    });

    it("preserves the full fallback when a failed stream has no provider acknowledgement", () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      ctrl.onPartialReply({ text: "hello world" });

      expect(ctrl.preparePayload({ text: "hello world final" })).toEqual({
        text: "hello world final",
      });
    });

    it("does not trim an independent later payload using a previous stream acknowledgement", () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello");
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      ctrl.onPartialReply({ text: "hello world" });

      expect(ctrl.preparePayload({ text: "hello world" })).toEqual({
        text: " world",
      });
      expect(ctrl.preparePayload({ text: "hello again" })).toEqual({
        text: "hello again",
      });
      expect(stream.events.off).not.toHaveBeenCalled();
    });

    it("ignores unrelated, informative, and out-of-order stream acknowledgements", () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello", { type: "message" });
      stream.acknowledge("hello", { channelData: { streamType: "informative" } });
      stream.acknowledge("unrelated");
      stream.acknowledge("he");
      stream.acknowledge("hello", { id: "different-stream" });
      stream.acknowledge("h");
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      ctrl.onPartialReply({ text: "hello world" });

      expect(ctrl.preparePayload({ text: "hello world" })).toEqual({
        text: "llo world",
      });
    });

    it("suppresses a failed fallback when Teams already acknowledged the entire text", () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello");
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      ctrl.onPartialReply({ text: "hello world" });

      expect(ctrl.preparePayload({ text: "hello" })).toBeUndefined();
    });

    it("retains media when Teams already acknowledged all fallback text", () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello");
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      ctrl.onPartialReply({ text: "hello world" });

      expect(
        ctrl.preparePayload({ text: "hello", mediaUrl: "https://example.com/image.png" }),
      ).toEqual({
        text: undefined,
        mediaUrl: "https://example.com/image.png",
      });
    });

    it("redelivers only unacknowledged text when stream close fails", async () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello");
      expect(ctrl.preparePayload({ text: "hello world" })).toBeUndefined();
      stream.close.mockRejectedValueOnce(new Error("close failed"));

      await expect(ctrl.finalize()).resolves.toEqual({
        visibleReplySent: true,
        content: "hello",
        messageId: "stream-acknowledged",
        fallbackPayload: { text: " world" },
      });
      expect(stream.events.off).toHaveBeenCalledWith(0);
      expect(ctrl.preparePayload({ text: "hello again" })).toEqual({ text: "hello again" });
    });

    it("does not redeliver an acknowledged final when stream close produces no activity", async () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello");
      expect(ctrl.preparePayload({ text: "hello" })).toBeUndefined();
      stream.close.mockResolvedValueOnce(undefined);

      await expect(ctrl.finalize()).resolves.toEqual({
        visibleReplySent: true,
        content: "hello",
        messageId: "stream-acknowledged",
      });
      expect(stream.events.off).toHaveBeenCalledWith(0);
    });

    it("honors cancellation after an acknowledged stream prefix", async () => {
      const stream = makeAcknowledgedStream();
      const ctrl = makeController({ stream });

      ctrl.onPartialReply({ text: "hello" });
      stream.acknowledge("hello");
      stream.canceled = true;

      expect(ctrl.preparePayload({ text: "hello world" })).toBeUndefined();
      await expect(ctrl.finalize()).resolves.toEqual({
        visibleReplySent: true,
        content: "hello",
        messageId: "stream-acknowledged",
      });
      expect(stream.events.off).toHaveBeenCalledWith(0);
    });

    it("treats post-cancel stream as inactive without further emit attempts", () => {
      const stream = makeStream();
      stream.emit.mockImplementationOnce(() => {
        throw makeCancelError();
      });
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "first chunk after stop" });
      // Subsequent partial replies should short-circuit and not call emit
      // again (the SDK would throw on every call once canceled).
      ctrl.onPartialReply({ text: "second chunk" });
      ctrl.onPartialReply({ text: "third chunk" });
      expect(stream.emit).toHaveBeenCalledTimes(1);
      expect(ctrl.isStreamActive()).toBe(false);
    });
  });

  describe("non-personal conversation", () => {
    it("does not stream in channels — onPartialReply is a no-op", () => {
      const stream = makeStream();
      const ctrl = makeController({ conversationType: "channel", stream });
      ctrl.onPartialReply({ text: "anything" });
      expect(stream.emit).not.toHaveBeenCalled();
    });
  });
});

describe("flattenInformativeStatus", () => {
  const bytes = (v: string) => new TextEncoder().encode(v).length;

  it("joins rows onto one line without bullets", () => {
    expect(flattenInformativeStatus("Working\n• tool: search\n- tool: exec\n\n")).toBe(
      "Working · tool: search · tool: exec",
    );
  });

  it("keeps the newest rows within 1000 characters", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `row ${i} ${"x".repeat(40)}`);
    const out = flattenInformativeStatus(rows.join("\n"));
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith(rows.at(-1)!)).toBe(true);
  });

  it("enforces the 1 KB limit for multi-byte text without splitting emoji", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `💬 ${i} 👋🏽 ägé`);
    const out = flattenInformativeStatus(rows.join("\n"));
    expect(bytes(out)).toBeLessThanOrEqual(1024);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.endsWith(rows.at(-1)!)).toBe(true);
    expect(out).toBe(out.toWellFormed());
    expect(out.startsWith("…")).toBe(true);
  });
});
