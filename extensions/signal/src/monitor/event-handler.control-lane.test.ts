import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalIngressLifecycle } from "../signal-ingress.js";
import type { SignalInboundEntry } from "./event-handler.control-lane.js";

const { dispatchMock, recordMock, receiptMock, typingMock, fixture } = vi.hoisted(() => ({
  fixture: { realSession: false },
  dispatchMock:
    vi.fn<(params: { ctx: MsgContext; replyOptions?: GetReplyOptions }) => Promise<unknown>>(),
  recordMock: vi.fn(),
  receiptMock: vi.fn(),
  typingMock: vi.fn(),
}));

// mock-isolation: Control-lane scheduling must not send live Signal messages or receipts.
vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: typingMock,
  sendReadReceiptSignal: receiptMock,
}));

// mock-isolation: Shared helper preserves real exports while isolating worker-backed dispatch.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  const { signalInboundTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  const mocked = await signalInboundTestModule(actual, recordMock, async (resolved) => {
    const result = dispatchMock({ ctx: resolved.ctxPayload, replyOptions: resolved.replyOptions });
    for (const [count, started] of dispatchStarts) {
      if (dispatchMock.mock.calls.length >= count) {
        started.resolve();
      }
    }
    return await result;
  });
  return {
    ...mocked,
    resolveInboundSessionEnvelopeContextAsync: (
      params: Parameters<typeof actual.resolveInboundSessionEnvelopeContextAsync>[0],
    ) =>
      fixture.realSession
        ? actual.resolveInboundSessionEnvelopeContextAsync(params)
        : mocked.resolveInboundSessionEnvelopeContextAsync(params),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  const { signalConversationTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  const mocked = signalConversationTestModule(actual, recordMock);
  return {
    ...actual,
    recordInboundSession: (...args: Parameters<typeof actual.recordInboundSession>) =>
      fixture.realSession
        ? actual.recordInboundSession(...args)
        : mocked.recordInboundSession(...args),
    readChannelAllowFromStore: (...args: Parameters<typeof actual.readChannelAllowFromStore>) =>
      fixture.realSession
        ? actual.readChannelAllowFromStore(...args)
        : mocked.readChannelAllowFromStore(),
    upsertChannelPairingRequest: (
      ...args: Parameters<typeof actual.upsertChannelPairingRequest>
    ) =>
      fixture.realSession
        ? actual.upsertChannelPairingRequest(...args)
        : mocked.upsertChannelPairingRequest(),
  };
});

const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("./event-handler.test-harness.js");
const { createSignalEventHandler } = await import("./event-handler.js");
const {
  createSignalPendingInboundRegistry: createRegistry,
  resolveSignalControlLaneKey: controlKey,
  resolveSignalInboundDebounceKey: debounceKey,
} = await import("./event-handler.control-lane.js");

const dispatchResult = { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
const pendingTasks: Promise<void>[] = [];
const activeGates: Array<() => void> = [];
const dispatchStarts = new Map<number, ReturnType<typeof createDeferred<void>>>();
let pendingDebounceMs = 0;

function waitForDispatch(count: number) {
  if (dispatchMock.mock.calls.length >= count) {
    return Promise.resolve();
  }
  const started = createDeferred<void>();
  dispatchStarts.set(count, started);
  return started.promise;
}

function createHandler(debounceMs: number, config?: OpenClawConfig) {
  pendingDebounceMs = Math.max(pendingDebounceMs, debounceMs);
  const dmPolicy = "allowlist";
  const allowFrom = ["+15550001111"];
  return createSignalEventHandler(
    createBaseSignalEventHandlerDeps({
      cfg: config ?? {
        messages: { inbound: { debounceMs } },
        channels: { signal: { dmPolicy, allowFrom } },
      },
      dmPolicy,
      allowFrom,
      historyLimit: 0,
      runTrackedTask: (task) => {
        pendingTasks.push(task());
      },
    }),
  );
}

function controlEntry(overrides: Partial<SignalInboundEntry> = {}): SignalInboundEntry {
  return {
    cfg: {},
    resolveChannelIngress: async () => {
      throw new Error("control-lane fixture must not resolve ingress");
    },
    senderName: "Alice",
    senderDisplay: "+15550001111",
    senderRecipient: "+15550001111",
    senderPeerId: "+15550001111",
    isGroup: true,
    groupId: "group-1",
    bodyText: "stop",
    commandBody: "stop",
    commandAuthorized: true,
    ...overrides,
  };
}

async function startHeldDispatch(debounceMs: number, message = "start a long task") {
  const gate = createDeferred<void>();
  activeGates.push(gate.resolve);
  dispatchMock.mockImplementationOnce(async () => {
    await gate.promise;
    return dispatchResult;
  });
  const handler = createHandler(debounceMs);
  const active = handler(signalText(message, 1));
  if (debounceMs) {
    await active;
  }
  await vi.advanceTimersByTimeAsync(debounceMs);
  await waitForDispatch(1);
  expect(dispatchMock).toHaveBeenCalledTimes(1);
  return { handler, active, release: gate.resolve };
}

function signalText(message: string, timestamp: number, sourceNumber?: string) {
  return createSignalReceiveEvent({
    ...(sourceNumber ? { sourceNumber, sourceName: sourceNumber } : {}),
    timestamp,
    dataMessage: {
      message,
      attachments: [],
      ...(sourceNumber ? { groupInfo: { groupId: "group-1", groupName: "Test Group" } } : {}),
    },
  });
}

function dispatchedCommandBody(index: number): string | undefined {
  const call = dispatchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected dispatch call ${index}`);
  }
  return call[0].ctx.CommandBody;
}

function expectDispatch(index: number, body: string) {
  expect(dispatchMock).toHaveBeenCalledTimes(index + 1);
  expect(dispatchedCommandBody(index)).toBe(body);
}

describe("Signal active-run control lane", () => {
  beforeEach(() => {
    fixture.realSession = false;
    vi.useFakeTimers();
    dispatchStarts.clear();
    dispatchMock.mockReset().mockResolvedValue(dispatchResult);
    recordMock.mockReset().mockResolvedValue(undefined);
    receiptMock.mockReset().mockResolvedValue(true);
    typingMock.mockReset().mockResolvedValue(true);
  });

  afterEach(async () => {
    try {
      for (const release of activeGates.splice(0)) {
        release();
      }
      // Shared runtime timers can recur; advance only this fixture's debounce window.
      await vi.advanceTimersByTimeAsync(pendingDebounceMs);
      // Debounce admission can finish before dispatch; drain the tracked completion.
      await Promise.all(pendingTasks.splice(0));
    } finally {
      pendingDebounceMs = 0;
      clearRuntimeConfigSnapshot();
      vi.useRealTimers();
    }
  });

  it("updates Signal batching while keeping stop on the immediate control lane", async () => {
    const cfg: OpenClawConfig = {
      messages: { inbound: { debounceMs: 0 } },
      channels: { signal: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const handler = createHandler(25, cfg);
    const publish = (debounceMs: number) => {
      const current = { ...cfg, messages: { inbound: { byChannel: { signal: debounceMs } } } };
      setRuntimeConfigSnapshot(current, current);
    };
    await handler(signalText("immediate", 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    publish(25);
    await handler(signalText("first", 2));
    await handler(signalText("second", 3));
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    await waitForDispatch(2);
    expect(dispatchedCommandBody(1)).toBe("first\nsecond");
    publish(0);
    await handler(signalText("after disable", 4));
    expect(dispatchedCommandBody(2)).toBe("after disable");
    publish(25);
    await handler(signalText("pending", 5));
    await handler(signalText("stop", 6));
    expect(dispatchedCommandBody(3)).toBe("stop");
    await vi.advanceTimersByTimeAsync(25);
    expect(dispatchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    { debounceMs: 5, text: "stop" },
    { debounceMs: 5, text: "/approve abc12345 allow-once" },
    { debounceMs: 5, text: "/status" },
    { debounceMs: 5, text: "/QUEUE" },
    { debounceMs: 5, text: "/steer keep going" },
    { debounceMs: 0, text: "one more detail" },
    { debounceMs: 0, text: "/reset" },
  ])(
    "dispatches $debounceMs-ms followup $text while normal work is active",
    async ({ debounceMs, text }) => {
      const { handler, active, release } = await startHeldDispatch(debounceMs);
      const followup = handler(signalText(text, 2));
      await vi.advanceTimersByTimeAsync(0);
      await waitForDispatch(2);
      expectDispatch(1, text);
      release();
      await Promise.all([active, followup]);
    },
  );

  it("does not promote or cancel an unauthorized abort", () => {
    const entry = controlEntry({ isGroup: false, groupId: undefined, commandAuthorized: false });
    const cancelKey = vi.fn(() => true);
    const pendingInboundRegistry = createRegistry("default");

    expect(debounceKey("default", entry)).toBe("signal:default:+15550001111:+15550001111");
    expect(controlKey("default", entry)).toBeNull();
    pendingInboundRegistry.track(entry);
    pendingInboundRegistry.cancelPendingOnAbort(entry, cancelKey);
    expect(cancelKey).not.toHaveBeenCalled();
  });

  it("cancels each pending sender once and forgets completed entries", () => {
    const entry = controlEntry();
    const second = { ...entry };
    const otherSender = { ...entry, senderPeerId: "+15550002222" };
    const otherGroup = { ...entry, groupId: "group-2" };
    expect(controlKey("default", entry)).toBe(controlKey("default", otherSender));
    expect(debounceKey("default", entry)).not.toBe(debounceKey("default", otherSender));
    const registry = createRegistry("default");
    for (const pending of [entry, entry, second, otherSender, otherGroup]) {
      registry.track(pending);
    }
    registry.complete([entry, entry]);
    const cancelKey = vi.fn(() => true);
    registry.cancelPendingOnAbort(entry, cancelKey);
    expect(cancelKey.mock.calls).toEqual([
      ["signal:default:group-1:+15550001111"],
      ["signal:default:group-1:+15550002222"],
    ]);
    registry.complete([second, otherSender]);
    cancelKey.mockClear();
    registry.cancelPendingOnAbort(entry, cancelKey);
    expect(cancelKey).not.toHaveBeenCalled();
  });

  it.each([
    { debounceMs: 0, message: "stop", commandText: "halt" },
    { debounceMs: 5, message: "start a long task", commandText: "/reset" },
    { debounceMs: 5, message: "start a long task", commandText: "/queue status" },
  ])(
    "serializes $commandText behind $message ($debounceMs-ms debounce)",
    async ({ debounceMs, message, commandText }) => {
      const { handler, active, release } = await startHeldDispatch(debounceMs, message);
      const statefulCommand = handler(signalText(commandText, 2));
      await vi.advanceTimersByTimeAsync(20);
      expect(dispatchMock).toHaveBeenCalledTimes(1);

      release();
      await Promise.all([active, statefulCommand]);
      expectDispatch(1, commandText);
    },
  );

  it.each([false, true])("cancels pending debounce work (group: %s)", async (group) => {
    const handler = createHandler(50);
    await handler(signalText("queued work", 1, group ? "+15550001111" : undefined));
    await handler(signalText("stop", 2, group ? "+15550002222" : undefined));
    expectDispatch(0, "stop");

    await vi.advanceTimersByTimeAsync(75);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels ordinary text released from debounce but still waiting on active work", async () => {
    const { handler, release } = await startHeldDispatch(5);
    await handler(signalText("queued followup", 2));
    await vi.advanceTimersByTimeAsync(20);

    await handler(signalText("stop", 3));
    expectDispatch(1, "stop");

    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });
});

const waitOptions = { timeout: 5_000 };

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
    fixture.realSession = true;
    vi.useRealTimers();
    dispatchMock.mockReset().mockImplementation(async (params) => {
      await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
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
    dispatchMock.mockRejectedValue(new Error("merged dispatch failed"));
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
    dispatchMock.mockResolvedValue({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    const handler = createSignalEventHandler(createBaseSignalEventHandlerDeps());
    const lifecycle = createTrackedLifecycle();

    const result = await handler(createDataEvent(1700000004000, "no adoption"), lifecycle);

    expect(result).toEqual({ kind: "deferred" });
    await vi.waitFor(() => expect(lifecycle.onAdopted).toHaveBeenCalledTimes(1), waitOptions);
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });
});
