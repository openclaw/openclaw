// Matrix tests cover handler plugin behavior.
import { testing as sessionBindingTesting } from "openclaw/plugin-sdk/session-binding-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";

// Split out of handler.test.ts (line-cap growth ratchet): these tests all
// cover the same narrow area -- finalizing/settling a Matrix live draft
// preview around a tool dispatch, and binding that settlement to the
// dispatch's own generation instead of a later, racy read. See
// handler.test.ts's "matrix monitor handler draft streaming" describe block
// for the rest of the draft-streaming suite this split leaves behind.

const sendMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "evt", roomId: "!room" })),
);
const sendSingleTextMessageMatrixMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ messageId: "$draft1", roomId: "!room" })),
);
const editMessageMatrixMock = vi.hoisted(() => vi.fn(async () => "$edited"));
const sendTypingMatrixMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareMatrixSingleTextMock = vi.hoisted(() =>
  vi.fn((text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  }),
);
const resolveMatrixMentionsForBodyMock = vi.hoisted(() =>
  vi.fn(async ({ body }: { body: string }) => {
    const userIds = Array.from(body.matchAll(/@[A-Za-z0-9._=/-]+:[^\s`<]+/g), (match) => match[0]);
    return {
      ...(body.includes("@room") ? { room: true } : {}),
      ...(userIds.length > 0 ? { user_ids: userIds } : {}),
    };
  }),
);
const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return {
    ...actual,
    getGlobalHookRunner: getGlobalHookRunnerMock,
  };
});

vi.mock("../send.js", () => ({
  editMessageMatrix: editMessageMatrixMock,
  prepareMatrixSingleText: prepareMatrixSingleTextMock,
  reactMatrixMessage: vi.fn(async () => {}),
  resolveMatrixMentionsForBody: resolveMatrixMentionsForBodyMock,
  sendMessageMatrix: sendMessageMatrixMock,
  sendSingleTextMessageMatrix: sendSingleTextMessageMatrixMock,
  sendReadReceiptMatrix: vi.fn(async () => {}),
  sendTypingMatrix: sendTypingMatrixMock,
}));

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn());

vi.mock("./replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replies.js")>()),
  deliverMatrixReplies: deliverMatrixRepliesMock,
}));

function waitForMatrixState<T>(
  assertion: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(assertion, { interval: 1, ...options });
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  installMatrixMonitorTestRuntime();
  getGlobalHookRunnerMock.mockReset().mockReturnValue(null);
  prepareMatrixSingleTextMock.mockReset().mockImplementation((text: string) => {
    const trimmedText = text.trim();
    return {
      trimmedText,
      convertedText: trimmedText,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
    };
  });
  resolveMatrixMentionsForBodyMock.mockClear();
  sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "evt", roomId: "!room" });
  sendTypingMatrixMock.mockReset().mockResolvedValue(undefined);
  deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());
});

afterEach(() => {
  vi.useRealTimers();
});

function mockCalls(mock: unknown, label: string): Array<Array<unknown>> {
  const mockState = (mock as { mock?: { calls?: Array<Array<unknown>> } }).mock;
  if (!mockState) {
    throw new Error(`${label}.mock was missing`);
  }
  const calls = mockState.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`${label}.mock.calls was not an array`);
  }
  return calls;
}

function callArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const call = mockCalls(mock, label).at(callIndex);
  if (!call) {
    throw new Error(`${label} call ${callIndex} was missing`);
  }
  return call[argIndex];
}

function lastCallArg(mock: unknown, argIndex: number, label: string) {
  const calls = mockCalls(mock, label);
  return callArg(mock, calls.length - 1, argIndex, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value && typeof value === "object", label).toBe(true);
  return value as Record<string, unknown>;
}

function findMockCall(mock: unknown, label: string, predicate: (call: Array<unknown>) => boolean) {
  const call = mockCalls(mock, label).find(predicate);
  if (!call) {
    throw new Error(`${label} was missing`);
  }
  return call;
}

function expectEditLiveFlag(eventId: string, text: string, expected: boolean | undefined) {
  const call = findMockCall(
    editMessageMatrixMock,
    `edit live flag call for ${eventId}`,
    ([room, editedEventId, body]) =>
      room === "!room:example.org" && editedEventId === eventId && body === text,
  );
  const options = requireRecord(call[3], "edit options");
  if (expected === undefined) {
    expect(Object.hasOwn(options, "live")).toBe(false);
  } else {
    expect(options.live).toBe(expected);
  }
}

function createMockMatrixDeliveryResult(messageId = "$reply1", content = "delivered") {
  return {
    messageIds: [messageId],
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    visibleReplySent: true,
    content,
  };
}

describe("matrix monitor handler draft streaming - tool dispatch settlement", () => {
  type DeliverFn = (
    payload: {
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      audioAsVoice?: boolean;
      spokenText?: string;
      ttsSupplement?: { spokenText: string; visibleTextAlreadyDelivered?: boolean };
      isCompactionNotice?: boolean;
      isError?: boolean;
      replyToId?: string;
    },
    info: { kind: string },
  ) => Promise<unknown>;
  type ReplyOpts = {
    onReplyStart?: () => Promise<void> | void;
    onPartialReply?: (payload: { text: string }) => void;
    onBlockReplyQueued?: (
      payload: {
        text?: string;
        isCompactionNotice?: boolean;
      },
      context?: { assistantMessageIndex?: number },
    ) => Promise<void> | void;
    onAssistantMessageStart?: () => void;
    onToolResultQueued?: () => void;
    onQueuedFollowupAdmitted?: () => Promise<void> | void;
    suppressDefaultToolProgressMessages?: boolean;
    onToolStart?: (payload: {
      itemId?: string;
      toolCallId?: string;
      name?: string;
      phase?: string;
      args?: Record<string, unknown>;
      detailMode?: "explain" | "raw";
    }) => Promise<void>;
    onItemEvent?: (payload: {
      itemId?: string;
      toolCallId?: string;
      [key: string]: unknown;
    }) => Promise<void> | void;
  };

  function createStreamingHarness(opts?: {
    replyToMode?: "off" | "first" | "all" | "batched";
    threadReplies?: "inbound" | "always";
    blockStreamingEnabled?: boolean;
    streaming?: "partial" | "quiet" | "progress" | "off";
    previewToolProgressEnabled?: boolean;
    accountConfig?: import("../../types.js").MatrixConfig;
  }) {
    let capturedDeliver: DeliverFn | undefined;
    let capturedOnError: ((error: unknown, info: { kind: string }) => void) | undefined;
    let capturedOnBeforeDeliverCancelled:
      | ((payload: unknown, info: { kind: string }) => Promise<void> | void)
      | undefined;
    let capturedReplyOpts: ReplyOpts | undefined;
    let resolveCaptured: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      resolveCaptured = resolve;
    });
    const notifyCaptured = () => {
      if (capturedDeliver && capturedReplyOpts) {
        resolveCaptured?.();
      }
    };
    // Gate that keeps the handler's model run alive until the test releases it.
    let resolveRunGate: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      resolveRunGate = resolve;
    });

    sendMessageMatrixMock.mockReset().mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    sendSingleTextMessageMatrixMock
      .mockReset()
      .mockResolvedValue({ messageId: "$draft1", roomId: "!room" });
    editMessageMatrixMock.mockReset().mockResolvedValue("$edited");
    deliverMatrixRepliesMock.mockReset().mockResolvedValue(createMockMatrixDeliveryResult());

    const redactEventMock = vi.fn(async () => "$redacted");
    const logVerboseMessage = vi.fn();

    const { handler } = createMatrixHandlerTestHarness({
      streaming: opts?.streaming ?? "quiet",
      accountConfig: opts?.accountConfig,
      previewToolProgressEnabled: opts?.previewToolProgressEnabled ?? false,
      blockStreamingEnabled: opts?.blockStreamingEnabled ?? false,
      replyToMode: opts?.replyToMode ?? "off",
      threadReplies: opts?.threadReplies,
      client: { redactEvent: redactEventMock },
      logVerboseMessage,
      createReplyDispatcherWithTyping: (params: Record<string, unknown> | undefined) => {
        capturedDeliver = params?.deliver as DeliverFn | undefined;
        capturedOnError = params?.onError as typeof capturedOnError;
        capturedOnBeforeDeliverCancelled =
          params?.onBeforeDeliverCancelled as typeof capturedOnBeforeDeliverCancelled;
        notifyCaptured();
        return {
          dispatcher: {
            markComplete: () => {},
            waitForIdle: async () => {},
          },
          replyOptions: {},
          markDispatchIdle: () => {},
          markRunComplete: () => {},
        };
      },
      dispatchInboundMessage: vi.fn(async (args: { replyOptions?: ReplyOpts }) => {
        capturedReplyOpts = args?.replyOptions;
        notifyCaptured();
        // Block until the test is done exercising callbacks.
        await runGate;
        return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
      }) as never,
    });

    const dispatch = async () => {
      // Start handler without awaiting — it blocks on runGate.
      const handlerDone = handler(
        "!room:example.org",
        createMatrixTextMessageEvent({ eventId: "$msg1", body: "hello" }),
      );
      await captured;
      return {
        deliver: capturedDeliver!,
        onError: capturedOnError!,
        onBeforeDeliverCancelled: capturedOnBeforeDeliverCancelled!,
        opts: capturedReplyOpts!,
        // Release the run gate and wait for the handler to finish
        // (including the finally block that stops the draft stream).
        finish: async () => {
          resolveRunGate?.();
          await handlerDone;
        },
      };
    };

    return { dispatch, redactEventMock, logVerboseMessage };
  }

  it("flushes and finalizes a live draft before a tool dispatch instead of leaving it stuck", async () => {
    vi.useFakeTimers();
    let finish: (() => Promise<void>) | undefined;
    try {
      const { dispatch } = createStreamingHarness({ streaming: "partial" });
      const streaming = await dispatch();
      const { opts, deliver } = streaming;
      finish = streaming.finish;

      // The throttle window starts at zero, so the model's very first
      // fragment sends immediately (this is how a fast turn's lead-in text
      // shows up truncated at just its first characters).
      opts.onPartialReply?.({ text: "He" });
      await waitForMatrixState(() => {
        expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
      });

      // The rest of the sentence arrives inside the throttle window, so this
      // update is only scheduled — not sent yet — when the tool call fires.
      opts.onPartialReply?.({ text: "Hej Markus! Full text" });
      expect(editMessageMatrixMock).not.toHaveBeenCalled();

      await deliver({ text: "tool result" }, { kind: "tool" });

      // The tool dispatch must flush the pending edit and strip the live
      // marker in place of leaving the draft orphaned at "He" forever.
      expect(lastCallArg(editMessageMatrixMock, 2, "Matrix draft finalize body")).toBe(
        "Hej Markus! Full text",
      );
      const finalizeOptions = requireRecord(
        lastCallArg(editMessageMatrixMock, 3, "Matrix draft finalize options"),
        "Matrix draft finalize options",
      );
      expect(finalizeOptions.live).toBe(false);
    } finally {
      try {
        await finish?.();
      } finally {
        vi.useRealTimers();
      }
    }
  });
  it("does not republish stale preview text after a block's final edit already replaced it", async () => {
    const { dispatch } = createStreamingHarness({
      blockStreamingEnabled: true,
      streaming: "partial",
    });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Single" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // "block" kind still runs beginNextBlockDraft() right after this
    // delivery settles. Its final text ("Single block") differs from the
    // draft's own cached preview ("Single"), so editFinal edits the real
    // text directly and bypasses draftStream's send cache — that cache
    // must not get replayed as a second, stale overwrite.
    await deliver({ text: "Single block" }, { kind: "block" });

    expect(editMessageMatrixMock).toHaveBeenCalledTimes(1);
    expectEditLiveFlag("$draft1", "Single block", undefined);
    await finish();
  });
  it("preserves a stuck draft's cleanup ownership when tool-dispatch finalization fails", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "Hello" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // The tool dispatch's own finalizeLive() edit rejects.
    editMessageMatrixMock.mockRejectedValueOnce(new Error("rate limited"));
    await deliver({ text: "tool result" }, { kind: "tool" });

    // A bare reset() here would wipe the event id and the
    // mustDeliverFinalNormally() failure state, so the final delivery below
    // would never learn "$draft1" needs redacting — orphaning it, still
    // live, forever. The event id and failure state must survive instead.
    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Final text" }, { kind: "final" });

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });
  it("preserves cleanup ownership when a pending (not first-create) edit fails during tool settlement", async () => {
    const { dispatch, redactEventMock } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "He" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // The rest of the sentence is still throttled/pending when the tool
    // call fires, so settlement's own flush must send it as a plain edit --
    // reject that specific edit (not a first-create), matching the gap
    // where only finalizeInPlaceBlocked from a preview-limit error, never a
    // generic edit rejection, used to unblock the redact-or-replace path.
    opts.onPartialReply?.({ text: "Hej Markus! Full text" });
    editMessageMatrixMock.mockRejectedValueOnce(new Error("rate limited"));
    await deliver({ text: "tool result" }, { kind: "tool" });

    // Without propagating that failure into mustDeliverFinalNormally(),
    // finalizeLive() would still succeed on the stale cached "He" and
    // settlement would report success, wiping the event id -- exactly the
    // orphaned-live-draft bug this PR fixes, just via a different trigger.
    deliverMatrixRepliesMock.mockClear();
    await deliver({ text: "Final text" }, { kind: "final" });

    expect(redactEventMock).toHaveBeenCalledWith("!room:example.org", "$draft1");
    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    await finish();
  });
  it("does not finalize a newer draft generation when a delayed tool delivery settles late", async () => {
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "First" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Production enqueues a tool's own Matrix delivery without awaiting
    // completion -- simulate that: the tool's send stays pending while a
    // fast-following assistant message already starts streaming new text
    // into the same shared draft.
    let resolveToolDelivery: (() => void) | undefined;
    deliverMatrixRepliesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToolDelivery = () => resolve(createMockMatrixDeliveryResult());
        }),
    );
    const toolDeliverPromise = deliver({ text: "tool result" }, { kind: "tool" });
    await waitForMatrixState(() => {
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    });

    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Second" });
    await waitForMatrixState(() => {
      expect(
        mockCalls(editMessageMatrixMock, "edit calls").some(
          ([, eventId, body]) => eventId === "$draft1" && body === "Second",
        ),
      ).toBe(true);
    });

    // Only now does the tool call's own delayed delivery finish.
    resolveToolDelivery?.();
    await toolDeliverPromise;

    // The tool call belonged to the first generation ("First"); it must not
    // finalize (strip the live marker on) the second generation's draft,
    // which is a different, still-in-flight block it doesn't own.
    expect(
      mockCalls(editMessageMatrixMock, "edit calls").some(
        ([, eventId, , options]) =>
          eventId === "$draft1" && requireRecord(options, "edit options").live === false,
      ),
    ).toBe(false);
    await finish();
  });
  it("binds two queued tool deliveries to their own dispatch-time generation, not whichever is current when deliver() finally runs", async () => {
    // ClawSweeper P2: production enqueues a tool result via the shared
    // dispatcher's serialized send queue (onToolResultQueued fires right
    // there, before any send delay) and only later drains to deliver().
    // Two tool calls issued from the SAME assistant message can both still
    // be queued behind a slow send when the NEXT assistant message already
    // starts and bumps the generation -- deliver() reading "current"
    // generation at that late point would see the bumped value for BOTH,
    // wrongly finalizing the newer message's still-live draft. Simulated
    // here by controlling exactly when each generation gets queued
    // (onToolResultQueued) versus when deliver() actually runs for it,
    // independent of this harness's own send timing.
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "First" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Both tool calls originate from generation 0 -- queued before either's
    // own send starts.
    opts.onToolResultQueued?.();
    opts.onToolResultQueued?.();

    // The next assistant message starts (and streams new text) while both
    // tool deliveries are still pending -- generation 0's own draft ("First")
    // is superseded by generation 1's ("Second") on the very same event.
    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Second" });
    await waitForMatrixState(() => {
      expect(
        mockCalls(editMessageMatrixMock, "edit calls").some(
          ([, eventId, body]) => eventId === "$draft1" && body === "Second",
        ),
      ).toBe(true);
    });

    let resolveFirstTool: (() => void) | undefined;
    deliverMatrixRepliesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstTool = () => resolve(createMockMatrixDeliveryResult());
        }),
    );
    const firstToolDeliver = deliver({ text: "tool result 1" }, { kind: "tool" });
    let resolveSecondTool: (() => void) | undefined;
    deliverMatrixRepliesMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecondTool = () => resolve(createMockMatrixDeliveryResult());
        }),
    );
    const secondToolDeliver = deliver({ text: "tool result 2" }, { kind: "tool" });
    await waitForMatrixState(() => {
      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(2);
    });

    resolveFirstTool?.();
    await firstToolDeliver;
    resolveSecondTool?.();
    await secondToolDeliver;

    // Neither delayed tool delivery owned generation 1 -- the still-live
    // "Second" draft must never have been finalized on their behalf.
    expect(
      mockCalls(editMessageMatrixMock, "edit calls").some(
        ([, eventId, , options]) =>
          eventId === "$draft1" && requireRecord(options, "edit options").live === false,
      ),
    ).toBe(false);
    await finish();
  });
  it("consumes its queued generation on a pre-deliver() tool failure, keeping the FIFO aligned for the next tool", async () => {
    // ClawSweeper P2 (found reviewing the fix above): a rejection from
    // beforeDeliver or another shared-dispatcher stage happens before
    // options.deliver is ever called, so this tool's own deliver() closure
    // never runs and never consumes its queued generation. Left unconsumed,
    // that stale entry would both settle this failure against the wrong
    // generation AND get wrongly taken by the *next* tool's deliver() call.
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, onError, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "First" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Two tool calls queued from generation 0.
    opts.onToolResultQueued?.();
    opts.onToolResultQueued?.();

    // The next assistant message starts and streams new text while both
    // tool calls are still pending.
    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Second" });
    await waitForMatrixState(() => {
      expect(
        mockCalls(editMessageMatrixMock, "edit calls").some(
          ([, eventId, body]) => eventId === "$draft1" && body === "Second",
        ),
      ).toBe(true);
    });

    // Only now does the first tool call fail, e.g. a beforeDeliver
    // rejection -- its own deliver() closure never ran at all.
    onError(new Error("boom"), { kind: "tool" });
    await deliver({ text: "tool result 2" }, { kind: "tool" });

    // The second tool call must still resolve to its own queued generation
    // (0), not whatever the first failure's unconsumed entry would have left
    // behind -- the still-live "Second" draft must never be finalized.
    expect(
      mockCalls(editMessageMatrixMock, "edit calls").some(
        ([, eventId, , options]) =>
          eventId === "$draft1" && requireRecord(options, "edit options").live === false,
      ),
    ).toBe(false);
    await finish();
  });
  it("does not let a stale queued tool settle a follow-up turn's draft after generation numbers reset", async () => {
    // ClawSweeper P2 (found reviewing the fix above): resetDraftDeliveryState
    // (fired by onQueuedFollowupAdmitted) deliberately keeps
    // pendingToolDispatchGenerations across the reset (a tool from the
    // interrupted turn can still be queued), but it must NOT also reset
    // currentDraftMessageGeneration back to a reused value -- generation 0
    // especially, since almost every turn's first message starts there. If
    // it did, an old tool queued at generation 0 would spuriously match the
    // new turn's own (also-reset-to-0) current generation and finalize its
    // still-live draft on the old tool's behalf.
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "First" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // A tool call is queued from generation 0, still pending when a queued
    // followup interrupts this turn.
    opts.onToolResultQueued?.();

    sendSingleTextMessageMatrixMock.mockClear();
    sendSingleTextMessageMatrixMock.mockResolvedValue({ messageId: "$draft2", roomId: "!room" });
    await opts.onQueuedFollowupAdmitted?.();
    opts.onPartialReply?.({ text: "Followup answer" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });

    // Only now does the original turn's delayed tool delivery finish.
    await deliver({ text: "tool result" }, { kind: "tool" });

    // The follow-up turn's own draft ($draft2) must never be finalized on
    // the old tool's behalf.
    expect(
      mockCalls(editMessageMatrixMock, "edit calls").some(
        ([, eventId, , options]) =>
          eventId === "$draft2" && requireRecord(options, "edit options").live === false,
      ),
    ).toBe(false);
    await finish();
  });
  it("consumes its queued generation when beforeDeliver cancels a tool payload, keeping the FIFO aligned for the next tool", async () => {
    // ClawSweeper P2 (found reviewing the fix above): beforeDeliver can
    // cancel a queued tool payload (return no payload) without ever
    // invoking deliver() or onError -- a third non-delivery path neither of
    // those two already-fixed paths cover. Left unconsumed, that entry
    // strands at the head of the FIFO and gets wrongly taken by the *next*
    // tool's deliver() call, making that next tool (which actually still
    // belongs to the live, unfinalized generation) appear to belong to an
    // older, already-superseded one instead -- and skip finalizing its own,
    // genuinely still-current draft.
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, onBeforeDeliverCancelled, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "First" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    opts.onToolResultQueued?.();

    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Second" });
    await waitForMatrixState(() => {
      expect(
        mockCalls(editMessageMatrixMock, "edit calls").some(
          ([, eventId, body]) => eventId === "$draft1" && body === "Second",
        ),
      ).toBe(true);
    });
    opts.onToolResultQueued?.();

    // The first tool's beforeDeliver cancels it -- deliver() and onError are
    // never called for it at all.
    await onBeforeDeliverCancelled({ text: "cancelled tool" }, { kind: "tool" });

    // The second tool still belongs to the current (not yet superseded)
    // generation and must correctly finalize its own draft.
    await deliver({ text: "tool result 2" }, { kind: "tool" });

    expect(
      mockCalls(editMessageMatrixMock, "edit calls").some(
        ([, eventId, , options]) =>
          eventId === "$draft1" && requireRecord(options, "edit options").live === false,
      ),
    ).toBe(true);
    await finish();
  });
  it("does not double-consume the FIFO when a beforeDeliver throw reaches both onBeforeDeliverCancelled and onError", async () => {
    // A beforeDeliver *throw* (as opposed to a plain cancellation) runs
    // onBeforeDeliverCancelled and then still reaches onError for the same
    // failure (the shared dispatcher re-throws after notifying). Without
    // toolDeliveryFailureSettled also covering this path, both callbacks
    // would consume a FIFO entry for the SAME failed tool -- eating the
    // *next* tool's entry too and leaving it to wrongly fall back to
    // whatever generation happens to be current by the time it delivers.
    const { dispatch } = createStreamingHarness({ streaming: "partial" });
    const { deliver, onError, onBeforeDeliverCancelled, opts, finish } = await dispatch();

    opts.onPartialReply?.({ text: "First" });
    await waitForMatrixState(() => {
      expect(sendSingleTextMessageMatrixMock).toHaveBeenCalledTimes(1);
    });
    opts.onToolResultQueued?.(); // tool #1, generation 0

    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Second" });
    opts.onToolResultQueued?.(); // tool #2, generation 1

    opts.onAssistantMessageStart?.();
    opts.onPartialReply?.({ text: "Third" });
    await waitForMatrixState(() => {
      expect(
        mockCalls(editMessageMatrixMock, "edit calls").some(
          ([, eventId, body]) => eventId === "$draft1" && body === "Third",
        ),
      ).toBe(true);
    });

    // Tool #1's beforeDeliver throws: the shared dispatcher calls both
    // callbacks in sequence for this one failure.
    await onBeforeDeliverCancelled({ text: "cancelled tool" }, { kind: "tool" });
    onError(new Error("boom"), { kind: "tool" });

    // Tool #2 (generation 1, already superseded by generation 2's "Third")
    // must resolve to its own real entry, not an empty queue falling back
    // to the live generation 2 -- which would wrongly look like a match and
    // finalize the still-live "Third" draft on tool #2's behalf.
    await deliver({ text: "tool result 2" }, { kind: "tool" });

    expect(
      mockCalls(editMessageMatrixMock, "edit calls").some(
        ([, eventId, , options]) =>
          eventId === "$draft1" && requireRecord(options, "edit options").live === false,
      ),
    ).toBe(false);
    await finish();
  });
});
