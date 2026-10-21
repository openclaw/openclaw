import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalIngressLifecycle } from "../signal-ingress.js";

vi.useRealTimers();
const waitOptions = { timeout: 5_000 };

type DispatchParams = {
  ctx: MsgContext;
  replyOptions?: { turnAdoptionLifecycle?: { onAdopted: () => Promise<void> | void } };
};

const { dispatchMock, recordMock, dispatchBehavior } = vi.hoisted(() => {
  const behavior = {
    adoptDuringDispatch: true,
    failBeforeAdoption: undefined as Error | undefined,
  };
  return {
    dispatchBehavior: behavior,
    recordMock: vi.fn(),
    dispatchMock: vi.fn(async (params: DispatchParams) => {
      if (behavior.failBeforeAdoption) {
        throw behavior.failBeforeAdoption;
      }
      if (behavior.adoptDuringDispatch) {
        // Mirror the real reply lane: adoption fires while dispatch runs.
        await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    }),
  };
});

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn(),
  sendReadReceiptSignal: vi.fn(),
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: vi.fn(async () => ({ ok: true })),
  removeReactionSignal: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  const { createSignalPreparedDispatchRunner } = await import("./event-handler.test-harness.js");
  return {
    ...actual,
    runChannelInboundEvent: createSignalPreparedDispatchRunner(
      actual.runChannelInboundEvent,
      recordMock,
      async (resolved) =>
        await dispatchMock({
          ctx: resolved.ctxPayload,
          replyOptions: resolved.replyOptions,
        }),
    ),
  };
});

const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("./event-handler.test-harness.js");
const { createSignalEventHandler } = await import("./event-handler.js");

function createTrackedLifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onFailed: vi.fn(),
    onAbandoned: vi.fn(),
  } satisfies SignalIngressLifecycle;
}

function createDataEvent(timestamp: number, message: string) {
  return createSignalReceiveEvent({
    sourceUuid: "11111111-2222-3333-4444-555555555555",
    timestamp,
    dataMessage: { timestamp, message },
  });
}

async function enqueueMergedClaims(timestamp: number) {
  const handler = createSignalEventHandler(
    createBaseSignalEventHandlerDeps({ cfg: { messages: { inbound: { debounceMs: 40 } } } }),
  );
  const first = createTrackedLifecycle();
  const second = createTrackedLifecycle();
  expect([
    await handler(createDataEvent(timestamp, "part one"), first),
    await handler(createDataEvent(timestamp + 100, "part two"), second),
  ]).toEqual([{ kind: "deferred" }, { kind: "deferred" }]);
  return [first, second];
}

describe("signal drain claim ownership", () => {
  beforeEach(() => {
    dispatchBehavior.adoptDuringDispatch = true;
    dispatchBehavior.failBeforeAdoption = undefined;
    dispatchMock.mockClear();
  });

  it("completes every constituent claim when debounced entries merge into one turn", async () => {
    const claims = await enqueueMergedClaims(1700000002000);
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1), waitOptions);
    await vi.waitFor(
      () => expect(claims.map((c) => c.onAdopted.mock.calls.length)).toEqual([1, 1]),
      waitOptions,
    );
  });

  it("fails every constituent claim when a merged dispatch rejects before adoption", async () => {
    dispatchBehavior.failBeforeAdoption = new Error("merged dispatch failed");
    const claims = await enqueueMergedClaims(1700000003500);
    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledOnce();
      expect(claims.map((c) => c.onFailed.mock.calls.length)).toEqual([1, 1]);
    }, waitOptions);
    for (const claim of claims) {
      expect(claim.onAdopted).not.toHaveBeenCalled();
      expect(claim.onAbandoned).not.toHaveBeenCalled();
    }
  });

  it("settles the claim for a turn that finishes without adoption", async () => {
    // A gated/no-reply dispatch must settle rather than dead-letter via the watchdog.
    dispatchBehavior.adoptDuringDispatch = false;
    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());
    const lifecycle = createTrackedLifecycle();

    const result = await handler(createDataEvent(1700000004000, "no adoption"), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1), waitOptions);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });
});
