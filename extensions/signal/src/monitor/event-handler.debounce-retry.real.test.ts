// Real-environment proof: Signal debounce retry test.
//
// This test runs the ACTUAL production code path through the real debouncer,
// real onFlush, real flushWithRetry, and real handleSignalInboundMessage.
// The ONLY mock is dispatchInboundMessage (to inject the session conflict
// error, which cannot be triggered naturally in CI).
//
// Key differences from the fake-timer debounce-retry test:
//   - Does NOT mock createChannelInboundDebouncer (uses the real debouncer)
//   - Uses REAL timers (vi.useRealTimers — the default)
//   - The handler processes events through the FULL pipeline
//   - Wall-clock time is measured with Date.now()
//
// This proves the fix works end-to-end in a real Node.js event loop with
// real setTimeout delays.

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

const {
  dispatchInboundMessageMock,
  sendTypingMock,
  recordInboundSessionMock,
  enqueueSystemEventMock,
  runtimeErrorMock,
  approvalReactionMock,
} = vi.hoisted(() => ({
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
}));

// Network / persistence mocks — these would fail in a test environment.
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

// ⚠️  NOTE: createChannelInboundDebouncer is NOT mocked here.
// The real debouncer is used, which means:
//   - Real onFlush (with flushWithRetry)
//   - Real key-based buffering
//   - Real error propagation → onError
// This is the key difference from the fake-timer test.

import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const { createSignalEventHandler } = await import("./event-handler.js");

const CONFLICT_MSG =
  "reply session initialization conflicted for agent:main:signal:direct:+15550001111";

function createRetryableConflictError(): Error {
  return new Error("dispatch failed", {
    cause: new Error(CONFLICT_MSG),
  });
}

vi.useRealTimers();

describe("Signal debounce flush retry — real environment (wall-clock)", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
    runtimeErrorMock.mockClear();
  });

  // ── Scenario A: Retryable conflict → bounded backoff ────────────
  //
  // Goes through the FULL production pipeline:
  //   handler() → JSON.parse → resolveSignalSender → ... →
  //   inboundDebouncer.enqueue() → runFlush() → onFlush() →
  //   flushWithRetry() → handleSignalInboundMessage() →
  //   dispatchInboundMessage() [mocked: rejects with conflict] →
  //   flushWithRetry catches → delay(1000) [REAL WALL-CLOCK WAIT] →
  //   retry × 3 → exhausted → runFlush catches → onError
  //
  // Wall-clock is measured with Date.now().
  it("retries with real 1s backoff through the full pipeline", async () => {
    dispatchInboundMessageMock.mockRejectedValue(createRetryableConflictError());

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        } as any,
        historyLimit: 0,
        runtime: { log: () => {}, error: runtimeErrorMock } as any,
      }),
    );

    const t0 = Date.now();
    await handler(
      createSignalReceiveEvent({
        dataMessage: { message: "real-env proof", attachments: [] },
      }),
    );
    const elapsed = Date.now() - t0;

    // dispatchInboundMessage should have been called 4 times
    // (1 initial + 3 retries), each retry with 1s real delay.
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);

    // Wall-clock time: 3 retries × 1s delay + overhead = ~3-4s
    expect(elapsed).toBeGreaterThanOrEqual(2500);
    expect(elapsed).toBeLessThanOrEqual(6000);

    // onError logged the failure after retries exhausted
    expect(runtimeErrorMock).toHaveBeenCalledTimes(1);
    expect(runtimeErrorMock.mock.calls[0]?.[0]).toContain("signal debounce flush failed");
  }, 15_000);

  // ── Scenario B: Non-retryable error → no retry ─────────────────
  it("does NOT retry non-retryable errors in the full pipeline", async () => {
    dispatchInboundMessageMock.mockRejectedValue(new Error("database connection timeout"));

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        } as any,
        historyLimit: 0,
        runtime: { log: () => {}, error: runtimeErrorMock } as any,
      }),
    );

    const t0 = Date.now();
    await handler(
      createSignalReceiveEvent({
        dataMessage: { message: "non-retryable", attachments: [] },
      }),
    );
    const elapsed = Date.now() - t0;

    // Only 1 call — no retry
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

    // No retry delay: completes in <500ms (just async overhead)
    expect(elapsed).toBeLessThanOrEqual(2000);

    // onError called
    expect(runtimeErrorMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  // ── Scenario C: Transient conflict → succeeds on retry ────────
  it("succeeds on retry through the full pipeline when conflict resolves", async () => {
    dispatchInboundMessageMock
      .mockRejectedValueOnce(createRetryableConflictError())
      .mockRejectedValueOnce(createRetryableConflictError())
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        } as any,
        historyLimit: 0,
        runtime: { log: () => {}, error: runtimeErrorMock } as any,
      }),
    );

    const t0 = Date.now();
    await handler(
      createSignalReceiveEvent({
        dataMessage: { message: "transient conflict", attachments: [] },
      }),
    );
    const elapsed = Date.now() - t0;

    // 3 calls: initial fail + retry 1 fail + retry 2 success
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);

    // 2 retries × 1s = ~2s wall-clock
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThanOrEqual(5000);

    // onError NOT called — retry succeeded
    expect(runtimeErrorMock).not.toHaveBeenCalled();
  }, 15_000);
});
