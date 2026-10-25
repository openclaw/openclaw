import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalIngressLifecycle } from "../signal-ingress.js";
import type { SignalEventHandlerDeps } from "./event-handler.types.js";

const { dispatchMock, recordMock, fixture } = vi.hoisted(() => ({
  fixture: { realSession: false },
  dispatchMock:
    vi.fn<(params: { ctx: MsgContext; replyOptions?: GetReplyOptions }) => Promise<unknown>>(),
  recordMock: vi.fn(),
}));

// mock-isolation: Control-lane scheduling must not send live Signal messages or receipts.
vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn(async () => true),
  sendReadReceiptSignal: vi.fn(async () => true),
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
      (fixture.realSession ? actual : mocked).recordInboundSession(...args),
    readChannelAllowFromStore: (...args: Parameters<typeof actual.readChannelAllowFromStore>) =>
      (fixture.realSession ? actual : mocked).readChannelAllowFromStore(...args),
    upsertChannelPairingRequest: (...args: Parameters<typeof actual.upsertChannelPairingRequest>) =>
      (fixture.realSession ? actual : mocked).upsertChannelPairingRequest(...args),
  };
});

const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("./event-handler.test-harness.js");
const { createSignalEventHandler } = await import("./event-handler.js");

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

function createHandler(
  debounceMs: number,
  config?: OpenClawConfig,
  overrides: Partial<SignalEventHandlerDeps> = {},
) {
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
      ...overrides,
    }),
  );
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
  return { handler, active, release: gate.resolve };
}

function signalText(
  message: string,
  timestamp: number,
  sourceNumber?: string,
  groupId = "group-1",
) {
  return createSignalReceiveEvent({
    ...(sourceNumber ? { sourceNumber, sourceName: sourceNumber } : {}),
    timestamp,
    dataMessage: {
      message,
      attachments: [],
      ...(sourceNumber ? { groupInfo: { groupId, groupName: "Test Group" } } : {}),
    },
  });
}

const dispatchedCommandBody = (index: number) =>
  dispatchMock.mock.calls[index]?.[0].ctx.CommandBody;

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

  it.each<[number, string, boolean, string?]>([
    [5, "stop", false],
    [5, "/approve abc12345 allow-once", false],
    [5, "/QUEUE", false],
    [0, "one more detail", false],
    [0, "/reset", false],
    [0, "halt", true, "stop"],
    [5, "/reset", true],
    [5, "/queue status", true],
  ])(
    "%i-ms followup %s has serialized=%s",
    async (debounceMs, text, serialized, message = "start a long task") => {
      const { handler, active, release } = await startHeldDispatch(debounceMs, message);
      const followup = handler(signalText(text, 2));
      await vi.advanceTimersByTimeAsync(serialized ? 20 : 0);
      if (!serialized) {
        await waitForDispatch(2);
      }
      expect(dispatchMock).toHaveBeenCalledTimes(serialized ? 1 : 2);
      release();
      await Promise.all([active, followup]);
      expectDispatch(1, text);
    },
  );

  it("does not dispatch an unauthorized abort or cancel authorized pending work", async () => {
    const handler = createHandler(50, undefined, { groupAllowFrom: [] });
    await handler(signalText("queued work", 1, "+15550001111"));
    await handler(signalText("stop", 2, "+15550002222"));
    expect(dispatchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expectDispatch(0, "queued work");
  });

  it.each([false, true])("cancels pending debounce work (group: %s)", async (group) => {
    const handler = createHandler(50);
    if (group) {
      await handler(signalText("other group", 0, "+15550003333", "group-2"));
    }
    await handler(signalText("queued work", 1, group ? "+15550001111" : undefined));
    await handler(signalText("stop", 2, group ? "+15550002222" : undefined));
    expectDispatch(0, "stop");

    await vi.advanceTimersByTimeAsync(75);
    expect(dispatchMock).toHaveBeenCalledTimes(group ? 2 : 1);
    if (group) {
      expect(dispatchedCommandBody(1)).toBe("other group");
    }
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

const createTrackedLifecycle = () =>
  ({
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onFailed: vi.fn(),
    onAbandoned: vi.fn(),
  }) satisfies SignalIngressLifecycle;

it.each(["adopted", "failed", "unadopted"] as const)(
  "settles every drain claim after %s dispatch",
  async (outcome) => {
    fixture.realSession = true;
    vi.useRealTimers();
    dispatchMock.mockReset().mockImplementation(async (params) => {
      if (outcome === "failed") {
        throw new Error("merged dispatch failed");
      }
      if (outcome === "adopted") {
        await params.replyOptions?.turnAdoptionLifecycle?.onAdopted();
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    const merged = outcome !== "unadopted";
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: merged ? 40 : 0 } } },
      }),
    );
    const claims = Array.from({ length: merged ? 2 : 1 }, createTrackedLifecycle);
    for (const [index, claim] of claims.entries()) {
      const timestamp =
        { adopted: 1700000002000, failed: 1700000003500, unadopted: 1700000004000 }[outcome] +
        index * 100;
      const event = createSignalReceiveEvent({
        sourceUuid: "11111111-2222-3333-4444-555555555555",
        timestamp,
        dataMessage: { timestamp, message: `part ${index}` },
      });
      expect(await handler(event, claim)).toEqual({ kind: "deferred" });
    }
    await vi.waitFor(
      () => {
        expect(dispatchMock).toHaveBeenCalledOnce();
        for (const claim of claims) {
          expect(claim.onAdopted).toHaveBeenCalledTimes(outcome === "failed" ? 0 : 1);
          expect(claim.onFailed).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
          expect(claim.onAbandoned).not.toHaveBeenCalled();
        }
      },
      { timeout: 5_000 },
    );
  },
);
