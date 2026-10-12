// Signal durable ingress tests cover append, recovery, and tombstone dedupe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-adapter.js";
import { startSignalIngressMonitor } from "./signal-ingress.js";

type SignalIngressQueue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];
type SignalIngressDispatch = Parameters<typeof startSignalIngressMonitor>[0]["dispatch"];

async function startMonitor(queue: SignalIngressQueue, dispatch: SignalIngressDispatch) {
  const monitor = await startSignalIngressMonitor({
    accountId: "default",
    queue,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  return { monitor, waitForIdle: monitor.waitForIdle };
}

function signalEvent(params?: {
  senderNumber?: string | null;
  senderUuid?: string;
  timestamp?: number;
  groupId?: string;
  message?: string;
  reaction?: boolean;
}): SignalSseEvent {
  const timestamp = params?.timestamp ?? 1_700_000_000_001;
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        ...(params?.senderNumber === null
          ? {}
          : { sourceNumber: params?.senderNumber ?? "+15550001111" }),
        ...(params?.senderUuid ? { sourceUuid: params.senderUuid } : {}),
        timestamp,
        dataMessage: {
          timestamp,
          ...(params?.reaction
            ? { reaction: { emoji: "👍", targetSentTimestamp: timestamp - 1 } }
            : { message: params?.message ?? "hello" }),
          ...(params?.groupId ? { groupInfo: { groupId: params.groupId } } : {}),
        },
      },
    }),
  };
}

async function withQueue<T>(
  fn: (queue: SignalIngressQueue, stateDir: string) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<SignalIngressPayload>({
    channelId: "signal",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue, stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Signal durable ingress", () => {
  it("propagates durable append failure before dispatch scheduling", async () => {
    await withQueue(async (queue) => {
      const appendError = new Error("sqlite unavailable");
      const failingQueue = {
        ...queue,
        enqueue: vi.fn().mockRejectedValue(appendError),
      } satisfies SignalIngressQueue;
      const dispatch = vi.fn();
      const monitor = await startSignalIngressMonitor({
        accountId: "default",
        queue: failingQueue,
        dispatch,
        runtime: { error: vi.fn(), log: vi.fn() },
      });
      try {
        await expect(monitor.receive(signalEvent())).rejects.toBe(appendError);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers an uncompleted append with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue) => {
      const event = signalEvent();
      const interruptedDispatch = vi.fn((_event, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const interrupted = await startMonitor(queue, interruptedDispatch);
      await interrupted.monitor.receive(event);
      await interrupted.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);
      await interrupted.monitor.stop();

      const recoveredDispatch = vi.fn().mockResolvedValue(undefined);
      const recovered = await startMonitor(queue, recoveredDispatch);
      try {
        await recovered.waitForIdle();
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
        const [recoveredEvent, recoveredLifecycle] = recoveredDispatch.mock.calls[0] ?? [];
        expect(recoveredEvent).toEqual(event);
        expect(recoveredLifecycle).toEqual(expect.any(Object));
      } finally {
        await recovered.monitor.stop();
      }
    });
  });

  it("completes only when deferred dispatch adoption becomes durable", async () => {
    await withQueue(async (queue) => {
      const event = signalEvent();
      let adopt: (() => void | Promise<void>) | undefined;
      const dispatch = vi.fn((_event, lifecycle) => {
        adopt = lifecycle.onAdopted;
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive(event);
        await started.waitForIdle();
        expect(await queue.listClaims()).toHaveLength(1);

        await started.monitor.receive(event);
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);

        expect(adopt).toBeDefined();
        await adopt?.();
        await started.monitor.receive(event);
        await started.waitForIdle();
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("dead-letters malformed persisted payloads without retry", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "malformed-event",
        {
          version: 1,
          receivedAt: 1,
          event: { event: "receive", data: "{" },
        },
        { receivedAt: 1, laneKey: "direct:number:+15550001111" },
      );
      const dispatch = vi.fn();
      const started = await startMonitor(queue, dispatch);
      try {
        await started.waitForIdle();
        expect((await queue.enqueue("malformed-event", {} as SignalIngressPayload)).kind).toBe(
          "failed",
        );
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("keeps a pending dual-identity message dispatchable through redelivery", async () => {
    await withQueue(async (queue) => {
      const sender = {
        senderNumber: "+15550002222",
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
      };
      const first = signalEvent({ ...sender, timestamp: 1_700_000_000_001, message: "first" });
      const second = signalEvent({ ...sender, timestamp: 1_700_000_000_002, message: "second" });
      let adoptFirst: (() => void | Promise<void>) | undefined;
      const dispatch = vi.fn<SignalIngressDispatch>((_event, lifecycle, payload) => {
        if (payload.envelope?.dataMessage?.message === "first") {
          adoptFirst = lifecycle.onAdopted;
          lifecycle.onDeferred();
          return { kind: "deferred" } as const;
        }
        return undefined;
      });
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive(first);
        await started.monitor.receive(second);
        await started.waitForIdle();
        expect(await queue.listPending()).toHaveLength(1);

        await started.monitor.receive(second);
        await started.waitForIdle();
        expect(await queue.listPending()).toHaveLength(1);

        await adoptFirst?.();
        await started.waitForIdle();
        expect(dispatch.mock.calls.map((call) => call[2].envelope?.dataMessage?.message)).toEqual([
          "first",
          "second",
        ]);
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it("keeps durable message dedupe scoped to its Signal account", async () => {
    await withQueue(async (queue, stateDir) => {
      const otherQueue = createChannelIngressQueueForTests<SignalIngressPayload>({
        channelId: "signal",
        accountId: "other",
        stateDir,
      });
      const firstDispatch = vi.fn().mockResolvedValue(undefined);
      const otherDispatch = vi.fn().mockResolvedValue(undefined);
      const first = await startMonitor(queue, firstDispatch);
      const other = await startSignalIngressMonitor({
        accountId: "other",
        queue: otherQueue,
        dispatch: otherDispatch,
        runtime: { error: vi.fn(), log: vi.fn() },
      });
      try {
        await first.monitor.receive(
          signalEvent({
            senderNumber: "+15550002222",
            senderUuid: "123e4567-e89b-12d3-a456-426614174000",
          }),
        );
        await other.receive(signalEvent({ senderNumber: "+15550002222" }));
        await first.waitForIdle();
        await other.waitForIdle();
        expect(firstDispatch).toHaveBeenCalledTimes(1);
        expect(otherDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await first.monitor.stop();
        await other.stop();
      }
    });
  });

  it("uses a direct-sender or group-conversation lane and stores the raw event", async () => {
    await withQueue(async (queue) => {
      const direct = signalEvent({ senderUuid: "123e4567-e89b-12d3-a456-426614174000" });
      const group = signalEvent({ groupId: "group-123", timestamp: 1_700_000_000_002 });
      const dispatch = vi.fn((_event, lifecycle) => {
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      });
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive(direct);
        await started.monitor.receive(group);
        await started.waitForIdle();

        expect(await queue.listClaims()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              laneKey: "direct:uuid:123e4567-e89b-12d3-a456-426614174000",
              payload: expect.objectContaining({ event: direct }),
            }),
            expect.objectContaining({
              laneKey: "group:group-123",
              payload: expect.objectContaining({ event: group }),
            }),
          ]),
        );
      } finally {
        await started.monitor.stop();
      }
    });
  });

  it.each([
    ["sync", { envelope: { sourceNumber: "+15550001111", timestamp: 1, syncMessage: {} } }],
    ["receipt", { envelope: { sourceNumber: "+15550001111", timestamp: 2, receiptMessage: {} } }],
  ])("does not journal %s envelopes", async (_label, payload) => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn();
      const started = await startMonitor(queue, dispatch);
      try {
        await started.monitor.receive({ event: "receive", data: JSON.stringify(payload) });
        await started.waitForIdle();
        await expect(queue.listPending({ limit: "all" })).resolves.toHaveLength(0);
        await expect(queue.listClaims()).resolves.toHaveLength(0);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await started.monitor.stop();
      }
    });
  });
});
