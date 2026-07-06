// Signal debounce retry proof test.
//
// Before the fix: Signal's debounce onError only logged "signal debounce flush
// failed" and silently dropped the message, with no retry. Slack and Telegram
// already had bounded retry for the same error class.
//
// After the fix: flushWithRetry() catches "reply session initialization
// conflicted" errors, waits 1s, and retries up to 3 times before finally
// giving up and logging.
//
// These tests prove:
//  1. A retryable conflict error triggers bounded backoff retries
//  2. A non-retryable error does NOT trigger retries (the fix is narrow)
//  3. A transient conflict that resolves on retry succeeds cleanly
//
// Test strategy (matching Slack's pattern at message-handler.test.ts):
// We mock createChannelInboundDebouncer to capture the onFlush callback, then
// invoke it directly with test entries so we don't need to trace through the
// full async handler pipeline (which has many await points before reaching
// the debouncer enqueue).

import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DispatchInboundMessageMockParams = {
  ctx: MsgContext;
  replyOptions?: {
    allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
    allowToolLifecycleWhenProgressHidden?: boolean;
    onReplyStart?: () => void | Promise<void>;
    onToolStart?: (payload: { name?: string }) => void | Promise<void>;
    onCompactionStart?: () => void | Promise<void>;
    onCompactionEnd?: () => void | Promise<void>;
  };
};

/** Represents a captured onFlush from createChannelInboundDebouncer. */
type OnFlushCallback = (entries: Record<string, unknown>[]) => Promise<void>;
type OnErrorCallback = (err: unknown, items: Record<string, unknown>[]) => void;

const {
  dispatchInboundMessageMock,
  sendTypingMock,
  recordInboundSessionMock,
  enqueueSystemEventMock,
  runtimeErrorMock,
  approvalReactionMock,
  onFlushCallbacks,
  onErrorCallbacks,
} = vi.hoisted(() => {
  const onFlushCbs: OnFlushCallback[] = [];
  const onErrorCbs: OnErrorCallback[] = [];
  return {
    dispatchInboundMessageMock: vi.fn<
      (params: DispatchInboundMessageMockParams) => Promise<{
        queuedFinal: boolean;
        counts: { tool: number; block: number; final: number };
      }>
    >(),
    sendTypingMock: vi.fn(),
    recordInboundSessionMock: vi.fn(),
    enqueueSystemEventMock: vi.fn(),
    runtimeErrorMock: vi.fn(),
    approvalReactionMock: vi.fn(async () => false),
    onFlushCallbacks: onFlushCbs,
    onErrorCallbacks: onErrorCbs,
  };
});

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: vi.fn(),
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn(async () => ({ ok: true })),
  removeReactionSignal: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    createChannelInboundDebouncer: (params: {
      onFlush: OnFlushCallback;
      onError?: OnErrorCallback;
    }) => {
      onFlushCallbacks.push(params.onFlush);
      if (params.onError) {
        onErrorCallbacks.push(params.onError);
      }
      return {
        debounceMs: 0,
        debouncer: {
          enqueue: vi.fn(),
          flushKey: vi.fn(),
          cancelKey: vi.fn(),
        },
      };
    },
    shouldDebounceTextInbound: () => false,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    recordInboundSession: recordInboundSessionMock,
    readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/system-event-runtime")>(
    "openclaw/plugin-sdk/system-event-runtime",
  );
  return {
    ...actual,
    enqueueSystemEvent: enqueueSystemEventMock,
  };
});

vi.mock("../approval-reactions.js", async () => {
  const actual = await vi.importActual<typeof import("../approval-reactions.js")>(
    "../approval-reactions.js",
  );
  return {
    ...actual,
    maybeResolveSignalApprovalReaction: approvalReactionMock,
  };
});

const { createSignalEventHandler } = await import("./event-handler.js");

const RETRYABLE_CONFLICT_MESSAGE =
  "reply session initialization conflicted for agent:main:signal:direct:+15550001111";
const RETRY_DELAY_MS = 1_000;

function createRetryableConflictError(): Error {
  return new Error("dispatch failed", {
    cause: new Error(RETRYABLE_CONFLICT_MESSAGE),
  });
}

// ── Test entry matching SignalInboundEntry shape ──────────────
function createTestEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    senderName: "Alice",
    senderDisplay: "+15550001111.1",
    senderRecipient: "+15550001111",
    senderPeerId: "+15550001111",
    isGroup: false,
    bodyText: "hello",
    commandBody: "hello",
    timestamp: 1700000000000,
    messageId: "1700000000000",
    commandAuthorized: true,
    canDetectMention: false,
    ...overrides,
  };
}

/**
 * Run onFlush and simulate the debouncer's runFlush error handling:
 * the error is caught and forwarded to onError, and the function never
 * throws to the caller.  Uses .catch() immediately so vitest never sees
 * an unhandled rejection.
 */
function runOnFlush(
  onFlush: OnFlushCallback,
  entry: Record<string, unknown>,
): { settled: Promise<unknown>; errorRef: { current: unknown } } {
  const errorRef: { current: unknown } = { current: undefined };
  const settled = onFlush([entry]).catch((err: unknown) => {
    errorRef.current = err;
    // Simulate the debouncer's runFlush: forward to onError.
    // The onError callback was captured during createHandler() and
    // calls deps.runtime.error(...) which we verify via runtimeErrorMock.
    if (onErrorCallbacks.length > 0) {
      try {
        onErrorCallbacks[0](err, [entry]);
      } catch {
        // runFlush silently ignores onError exceptions
      }
    }
  });
  return { settled, errorRef };
}

vi.useRealTimers();

describe("Signal debounce flush retry on session initialization conflict", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
    sendTypingMock.mockClear();
    runtimeErrorMock.mockClear();
    recordInboundSessionMock.mockClear();
    enqueueSystemEventMock.mockClear();
    onFlushCallbacks.length = 0;
    onErrorCallbacks.length = 0;
  });

  // ─── Generate the handler to capture onFlush ────────────────
  function createHandler(): OnFlushCallback {
    createSignalEventHandler({
      runtime: { log: () => {}, error: runtimeErrorMock } as any,
      cfg: { channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } } },
      baseUrl: "http://localhost",
      accountId: "default",
      historyLimit: 0,
      groupHistories: new Map(),
      textLimit: 4000,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupAllowFrom: ["*"],
      groupPolicy: "open",
      reactionMode: "off",
      reactionAllowlist: [],
      mediaMaxBytes: 1024,
      ignoreAttachments: true,
      sendReadReceipts: false,
      readReceiptsViaDaemon: false,
      fetchAttachment: async () => null,
      deliverReplies: async () => {},
      resolveSignalReactionTargets: () => [],
      isSignalReactionMessage: () => false,
      shouldEmitSignalReactionNotification: () => false,
      buildSignalReactionSystemEventText: () => "reaction",
    } as any);
    return onFlushCallbacks[0]!;
  }

  // ─── Proof 1: Retryable conflict triggers bounded backoff ──
  //
  // Core proof: before the fix, the conflict error landed in onError
  // (only logging). After the fix, flushWithRetry retries with 1s
  // backoff up to 3 times.
  //
  // dispatchInboundMessage must be called (1 initial + MAX_RETRIES)
  // times with intervening 1s delays, and onError fires after
  // retries are exhausted.
  it("retries reply session initialization conflicts up to max attempts with 1s backoff", async () => {
    dispatchInboundMessageMock.mockRejectedValue(createRetryableConflictError());

    const onFlush = createHandler();

    vi.useFakeTimers();
    try {
      const { settled, errorRef } = runOnFlush(onFlush, createTestEntry());

      // Wait for initial attempt — microtask settles the mock rejection
      // and flushWithRetry enters the delay(1000) wait
      await vi.advanceTimersByTimeAsync(1);
      // Without the fix, dispatchInboundMessage would only be called
      // once and the error would land in onError.
      // With the fix, flushWithRetry retries after delay(1000).
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      // Advance past retry 1
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);

      // Advance past retry 2
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);

      // Advance past retry 3 — exhausted, flushWithRetry throws
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);

      // Wait for the flush promise to settle
      await settled;
      expect(errorRef.current).toBeDefined();
      expect(String(errorRef.current)).toContain("dispatch failed");

      // onError logged the failure — String(err) shows the outer message
      // while the full error cause graph (checked by collectErrorGraphCandidates
      // in production) retains the conflict marker
      expect(runtimeErrorMock).toHaveBeenCalledTimes(1);
      expect(runtimeErrorMock.mock.calls[0]?.[0]).toContain("signal debounce flush failed");
      expect(runtimeErrorMock.mock.calls[0]?.[0]).toContain("dispatch failed");
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  // ─── Proof 2: Non-retryable errors do NOT trigger retry ─────
  //
  // Proves the fix is narrow. A non-retryable error should not be
  // retried—the message is dropped after the initial attempt.
  it("does not retry non-retryable errors", async () => {
    dispatchInboundMessageMock.mockRejectedValue(new Error("database connection timeout"));

    const onFlush = createHandler();

    vi.useFakeTimers();
    try {
      const { settled, errorRef } = runOnFlush(onFlush, createTestEntry());

      // Wait for initial attempt — microtask settles the rejection
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      // Advance well past the retry window — no retry should happen
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 5);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      // Flush settled with non-retryable error
      await settled;
      expect(errorRef.current).toBeDefined();
      expect(String(errorRef.current)).toContain("database connection timeout");

      // onError called once
      expect(runtimeErrorMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Proof 3: Transient conflict resolves on retry ──────────
  //
  // The most realistic scenario: first attempt(s) contend with a
  // still-committing session; a retry sees the coast clear.
  // flushWithRetry stops on success and does NOT call onError.
  it("succeeds on retry when the conflict resolves", async () => {
    dispatchInboundMessageMock
      .mockRejectedValueOnce(createRetryableConflictError())
      .mockRejectedValueOnce(createRetryableConflictError())
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });

    const onFlush = createHandler();

    vi.useFakeTimers();
    try {
      const { settled, errorRef } = runOnFlush(onFlush, createTestEntry());

      // Advance past initial attempt (fails)
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      // Advance past retry 1 — fails again
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);

      // Advance past retry 2 — succeeds!
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);

      // Flush promise settles successfully
      await settled;
      expect(errorRef.current).toBeUndefined();

      // onError should NOT have been called — retry succeeded
      expect(runtimeErrorMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
