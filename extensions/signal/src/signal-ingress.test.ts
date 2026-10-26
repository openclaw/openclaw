import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-adapter.js";
import type { SignalDataMessage, SignalEnvelope } from "./monitor/event-handler.types.js";
import { startSignalIngressMonitor } from "./signal-ingress.js";

type SignalIngressQueue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];
type SignalIngressDispatch = Parameters<typeof startSignalIngressMonitor>[0]["dispatch"];
const defer = (_event: SignalSseEvent, lifecycle: Parameters<SignalIngressDispatch>[1]) => {
  lifecycle.onDeferred();
  return { kind: "deferred" } as const;
};

function signalEvent(
  envelope: SignalEnvelope = {},
  dataMessage: SignalDataMessage = {},
): SignalSseEvent {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        timestamp: 1_700_000_000_001,
        ...envelope,
        dataMessage: { message: "hello", ...dataMessage },
      },
    }),
  };
}

type Monitor = Awaited<ReturnType<typeof startSignalIngressMonitor>>;
let queue: SignalIngressQueue;
const monitors = new Set<Monitor>();
beforeEach(() => {
  queue = createChannelIngressQueueForTests<SignalIngressPayload>({
    channelId: "signal",
    accountId: "default",
    stateDir: tempDirs.make("openclaw-signal-ingress-"),
  });
});
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      for (const monitor of monitors) {
        await monitor.stop();
      }
    } finally {
      monitors.clear();
      closeOpenClawStateDatabaseForTest();
      cleanup();
      vi.restoreAllMocks();
    }
  }),
);
async function start(dispatch: SignalIngressDispatch, target = queue) {
  const monitor = await startSignalIngressMonitor({
    accountId: "default",
    queue: target,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  monitors.add(monitor);
  return monitor;
}
async function receive(monitor: Monitor, ...events: SignalSseEvent[]) {
  for (const event of events) {
    await monitor.receive(event);
  }
  await monitor.waitForIdle();
}

describe("Signal durable ingress", () => {
  it("propagates durable append failure before dispatch scheduling", async () => {
    const appendError = new Error("sqlite unavailable");
    const failingQueue = {
      ...queue,
      enqueue: vi.fn().mockRejectedValue(appendError),
      enqueueAndClaim: vi.fn().mockRejectedValue(appendError),
    } satisfies SignalIngressQueue;
    const dispatch = vi.fn();
    const monitor = await start(dispatch, failingQueue);
    await expect(monitor.receive(signalEvent())).rejects.toBe(appendError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists independent conversation lanes and recovers each raw event exactly once", async () => {
    const direct = signalEvent({ sourceUuid: "123e4567-e89b-12d3-a456-426614174000" });
    const group = signalEvent(
      { timestamp: 1_700_000_000_002 },
      { groupInfo: { groupId: "group-123" } },
    );
    const interrupted = await start(defer);
    await receive(interrupted, direct, group);
    expect(
      (await queue.listClaims()).map(({ laneKey, payload }) => [laneKey, payload.event]),
    ).toEqual(
      expect.arrayContaining([
        ["direct:uuid:123e4567-e89b-12d3-a456-426614174000", direct],
        ["group:group-123", group],
      ]),
    );
    await interrupted.stop();
    monitors.delete(interrupted);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    await (await start(dispatch)).waitForIdle();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      expect.arrayContaining([
        [direct, expect.any(Object)],
        [group, expect.any(Object)],
      ]),
    );
  });

  it("completes only when deferred dispatch adoption becomes durable", async () => {
    const event = signalEvent();
    let adopt: (() => void | Promise<void>) | undefined;
    const dispatch = vi.fn((_event, lifecycle) => {
      adopt = lifecycle.onAdopted;
      return defer(_event, lifecycle);
    });
    const started = await start(dispatch);
    await receive(started, event);
    expect(await queue.listClaims()).toHaveLength(1);
    await receive(started, event);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(adopt).toBeDefined();
    await adopt?.();
    await receive(started, event);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dead-letters malformed persisted payloads without retry", async () => {
    await queue.enqueue(
      "malformed-event",
      { version: 1, receivedAt: 1, event: { event: "receive", data: "{" } },
      { receivedAt: 1, laneKey: "direct:number:+15550001111" },
    );
    const dispatch = vi.fn();
    const started = await start(dispatch);
    await started.waitForIdle();
    await expect(
      queue.enqueue("malformed-event", {} as SignalIngressPayload),
    ).resolves.toMatchObject({ kind: "failed" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a pending dual-identity message dispatchable through redelivery", async () => {
    const sender = {
      sourceNumber: "+15550002222",
      sourceUuid: "123e4567-e89b-12d3-a456-426614174000",
    };
    const first = signalEvent(sender, { message: "first" });
    const second = signalEvent({ ...sender, timestamp: 1_700_000_000_002 }, { message: "second" });
    let adoptFirst: (() => void | Promise<void>) | undefined;
    const dispatch = vi.fn<SignalIngressDispatch>((_event, lifecycle, payload) => {
      if (payload.envelope?.dataMessage?.message === "first") {
        adoptFirst = lifecycle.onAdopted;
        return defer(_event, lifecycle);
      }
      return undefined;
    });
    const started = await start(dispatch);
    await receive(started, first, second);
    expect(await queue.listPending()).toHaveLength(1);
    await receive(started, second);
    expect(await queue.listPending()).toHaveLength(1);
    await adoptFirst?.();
    await started.waitForIdle();
    expect(dispatch.mock.calls.map((call) => call[2].envelope?.dataMessage?.message)).toEqual([
      "first",
      "second",
    ]);
  });

  it.each([
    ["sync", { envelope: { sourceNumber: "+15550001111", timestamp: 1, syncMessage: {} } }],
    ["receipt", { envelope: { sourceNumber: "+15550001111", timestamp: 2, receiptMessage: {} } }],
  ])("does not journal %s envelopes", async (_label, payload) => {
    const dispatch = vi.fn();
    const started = await start(dispatch);
    await receive(started, { event: "receive", data: JSON.stringify(payload) });
    await expect(queue.listPending({ limit: "all" })).resolves.toHaveLength(0);
    await expect(queue.listClaims()).resolves.toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
