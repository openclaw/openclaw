// Signal tests cover retry behavior for reply session initialization conflicts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

const {
  sendTypingMock,
  sendReadReceiptMock,
  sendReactionSignalMock,
  removeReactionSignalMock,
  dispatchInboundMessageMock,
  recordInboundSessionMock,
} = vi.hoisted(() => ({
  sendTypingMock: vi.fn(),
  sendReadReceiptMock: vi.fn(),
  sendReactionSignalMock: vi.fn(async () => ({ ok: true })),
  removeReactionSignalMock: vi.fn(async () => ({ ok: true })),
  dispatchInboundMessageMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: sendReactionSignalMock,
  removeReactionSignal: removeReactionSignalMock,
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

const CONFLICT_ERROR = new Error(
  "reply session initialization conflicted for agent:main:signal:direct:+15550001111",
);

describe("signal reply session init conflict retry", () => {
  beforeEach(() => {
    vi.useRealTimers();
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    sendReactionSignalMock.mockReset().mockResolvedValue({ ok: true });
    removeReactionSignalMock.mockReset().mockResolvedValue({ ok: true });
    recordInboundSessionMock.mockReset().mockResolvedValue(undefined);
    dispatchInboundMessageMock.mockReset();
  });

  it("retries a debounced flush that fails with a reply session init conflict", async () => {
    dispatchInboundMessageMock
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockResolvedValueOnce({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });

    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());

    vi.useFakeTimers();
    try {
      await handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "hello after prior turn",
            attachments: [],
          },
        }),
      );

      // Initial flush fails and schedules a retry.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);

      // Retry should have re-enqueued and flushed again.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the configured number of retry attempts", async () => {
    dispatchInboundMessageMock.mockRejectedValue(CONFLICT_ERROR);

    const errorLogs: string[] = [];
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        runtime: {
          log: () => {},
          error: (msg: string) => {
            errorLogs.push(msg);
          },
        } as any,
      }),
    );

    vi.useFakeTimers();
    try {
      await handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "hello after prior turn",
            attachments: [],
          },
        }),
      );

      // Initial attempt.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);

      // No further retries should be scheduled; advancing again does nothing.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);

      expect(errorLogs.some((msg) => msg.includes("signal debounce flush failed"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-conflict flush failures", async () => {
    dispatchInboundMessageMock.mockRejectedValue(new Error("some other dispatch failure"));

    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());

    vi.useFakeTimers();
    try {
      await handler(
        createSignalReceiveEvent({
          dataMessage: {
            message: "hello",
            attachments: [],
          },
        }),
      );

      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries each entry in a batched flush independently", async () => {
    dispatchInboundMessageMock
      .mockRejectedValueOnce(CONFLICT_ERROR)
      .mockResolvedValueOnce({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 10 } },
        } as any,
      }),
    );

    vi.useFakeTimers();
    try {
      const first = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000001,
          dataMessage: { message: "first", attachments: [] },
        }),
      );
      const second = handler(
        createSignalReceiveEvent({
          timestamp: 1700000000002,
          dataMessage: { message: "second", attachments: [] },
        }),
      );

      await vi.advanceTimersByTimeAsync(20);
      await Promise.all([first, second]);

      // Both messages were batched and the combined flush failed once.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);

      // Retry should reprocess the batched messages.
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
