// Requester settle wake tests cover the registry-less top-level requester:
// drain gating, batch idempotency, and the guards that keep the wake out of
// nested/cron/single-delivered paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const deliverSpy = vi.fn(
  async (
    _params: Record<string, unknown>,
  ): Promise<{ delivered: boolean; path: string; terminal?: boolean; reason?: string }> => ({
    delivered: true,
    path: "direct",
  }),
);

let sessionStore: Record<string, { sessionId?: string; lastChannel?: string; lastTo?: string }>;

const { registryRuntimeMock } = vi.hoisted(() => ({
  registryRuntimeMock: {
    hasDescendantRunAwaitingSettle: vi.fn(
      (_rootSessionKey: string, _excludeRunId?: string) => false,
    ),
    listSubagentRunsForRequester: vi.fn((_requesterSessionKey: string): unknown[] => []),
    getLatestSubagentRunByChildSessionKey: vi.fn((_childSessionKey: string) => undefined),
  },
}));

vi.mock("./subagent-announce.registry.runtime.js", () => registryRuntimeMock);

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  getRuntimeConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  loadSessionStore: vi.fn(() => ({})),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSessionEntry: vi.fn(() => undefined),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: sessionStore[sessionKey],
    canonicalKey: sessionKey,
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));

import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.js";

const REQUESTER = "agent:main:main";

function makeSettledChild(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-child";
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 2_000,
    endedAt: 3_000,
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    ...overrides,
  };
}

function wakeParams(
  overrides?: Partial<Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]>,
) {
  return {
    requesterSessionKey: REQUESTER,
    settledEntry: makeSettledChild({ runId: "run-b" }),
    ...overrides,
  };
}

function deliveredCallArg(): Record<string, unknown> {
  const call = deliverSpy.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected deliverSubagentAnnouncement call");
  }
  return call;
}

describe("maybeWakeRequesterAfterAllChildrenSettled", () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    sessionStore = { [REQUESTER]: { sessionId: "sess-main" } };
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.getLatestSubagentRunByChildSessionKey
      .mockReset()
      .mockReturnValue(undefined);
  });

  it("wakes the requester once with a batch-stable idempotency key when the fan-out drains", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        completion: { required: true, resultText: "network findings" },
      }),
      makeSettledChild({
        runId: "run-a",
        completion: { required: true, resultText: "social findings" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const call = deliveredCallArg();
    expect(call.targetRequesterSessionKey).toBe(REQUESTER);
    expect(call.requesterIsSubagent).toBe(false);
    expect(call.expectsCompletionMessage).toBe(false);
    expect(call.directIdempotencyKey).toBe(`announce:requester-settle:${REQUESTER}:run-a,run-b`);
    const message = String(call.triggerMessage);
    expect(message).toContain("settled");
    expect(message).toContain("social findings");
    expect(message).toContain("network findings");
    expect(registryRuntimeMock.hasDescendantRunAwaitingSettle).toHaveBeenCalledWith(
      REQUESTER,
      "run-b",
    );
  });

  it("computes the same idempotency key for concurrent last-sibling settles", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: makeSettledChild({ runId: "run-a" }) }),
    );
    await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: makeSettledChild({ runId: "run-b" }) }),
    );

    expect(deliverSpy).toHaveBeenCalledTimes(2);
    const [first, second] = deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey);
    // The gateway dedupes on this key, so equal keys mean exactly one wake turn.
    expect(first).toBe(second);
  });

  it("uses a new batch signature for a later second batch", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
      makeSettledChild({ runId: "run-c" }),
      makeSettledChild({ runId: "run-d" }),
    ]);
    await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: makeSettledChild({ runId: "run-d" }) }),
    );

    const keys = deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("includes the whole connected drained wave for a staggered fan-out", async () => {
    // A overlaps B and B overlaps C, but A never overlaps C. When C settles
    // last, A's results must still ride the wake and the idempotency key must
    // cover the full component (any last-settler computes the same batch).
    const childA = makeSettledChild({
      runId: "run-a",
      createdAt: 1_000,
      startedAt: 1_000,
      endedAt: 2_000,
      completion: { required: true, resultText: "alpha findings" },
    });
    const childB = makeSettledChild({
      runId: "run-b",
      createdAt: 1_500,
      startedAt: 1_500,
      endedAt: 3_000,
      completion: { required: true, resultText: "bravo findings" },
    });
    const childC = makeSettledChild({
      runId: "run-c",
      createdAt: 2_500,
      startedAt: 2_500,
      endedAt: 4_000,
      completion: { required: true, resultText: "charlie findings" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([childA, childB, childC]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: childC }),
    );

    expect(woke).toBe(true);
    const call = deliveredCallArg();
    expect(call.directIdempotencyKey).toBe(
      `announce:requester-settle:${REQUESTER}:run-a,run-b,run-c`,
    );
    const message = String(call.triggerMessage);
    expect(message).toContain("alpha findings");
    expect(message).toContain("bravo findings");
    expect(message).toContain("charlie findings");
  });

  it("ignores long-settled children from earlier non-overlapping spawns", async () => {
    // A one-off completion after an old fan-out must not re-wake the requester
    // about the historical batch: the old children ended before this one began.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-old-1", createdAt: 100, startedAt: 100, endedAt: 200 }),
      makeSettledChild({ runId: "run-old-2", createdAt: 100, startedAt: 110, endedAt: 250 }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("does not wake while other children still await settle", async () => {
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(true);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("leaves nested orchestrators to the descendant-settle wake", async () => {
    const nestedRequester = "agent:main:subagent:middle";
    sessionStore[nestedRequester] = { sessionId: "sess-middle" };
    // A qualifying drained wave, so the depth guard is what rejects.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a", requesterSessionKey: nestedRequester }),
      makeSettledChild({ runId: "run-b", requesterSessionKey: nestedRequester }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterSessionKey: nestedRequester }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("skips cron requester sessions", async () => {
    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterSessionKey: "agent:main:cron:daily-report" }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("skips requesters whose session entry is gone", async () => {
    sessionStore = {};
    // A qualifying drained wave, so the missing session entry is what rejects.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("does not add a wake turn after a single delivered completion", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-b", delivery: { status: "delivered" } }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("wakes for a single required completion whose announce never delivered", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        delivery: { status: "suspended", suspendedAt: 4_000 },
        completion: { required: true, resultText: "orphaned findings" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    expect(String(deliveredCallArg().triggerMessage)).toContain("orphaned findings");
  });

  it("stays out of pure fire-and-forget batches", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-a",
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
      makeSettledChild({
        runId: "run-b",
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("retries a transiently failed wake with a fresh idempotency suffix", async () => {
    // The wake is the only event after a drained fan-out; a wake turn lost to
    // a provider stall must not re-park the requester. The gateway dedupe
    // caches terminal outcomes per key, so each retry needs a fresh suffix.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValueOnce({ delivered: false, path: "direct" });

    vi.useFakeTimers();
    try {
      const wakePromise = maybeWakeRequesterAfterAllChildrenSettled(wakeParams());
      await vi.advanceTimersByTimeAsync(30_000);
      const woke = await wakePromise;

      expect(woke).toBe(true);
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      const keys = deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey);
      expect(keys[0]).toBe(`announce:requester-settle:${REQUESTER}:run-a,run-b`);
      expect(keys[1]).toBe(`announce:requester-settle:${REQUESTER}:run-a,run-b:retry-1`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after bounded retries when the wake keeps failing", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValue({ delivered: false, path: "direct" });

    vi.useFakeTimers();
    try {
      const wakePromise = maybeWakeRequesterAfterAllChildrenSettled(wakeParams());
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(120_000);
      const woke = await wakePromise;

      expect(woke).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
    }
  });

  it("does not retry a terminal delivery failure", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValueOnce({ delivered: false, path: "direct", terminal: true });

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });
});
