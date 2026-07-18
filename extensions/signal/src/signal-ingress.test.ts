// Signal durable ingress tests cover append, recovery, and tombstone dedupe.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-adapter.js";
import { setSignalRuntime } from "./runtime.js";
import {
  clearSignalRuntimeForTest,
  signalIngressTesting,
  type SignalIngressPayload,
} from "./runtime.test-support.js";
import { startSignalIngressMonitor } from "./signal-ingress.js";

const createSignalIngressDrain = (
  ...args: Parameters<typeof signalIngressTesting.createSignalIngressDrain>
) => signalIngressTesting.createSignalIngressDrain(...args);
const enqueueSignalIngressEvent = (
  ...args: Parameters<typeof signalIngressTesting.enqueueSignalIngressEvent>
) => signalIngressTesting.enqueueSignalIngressEvent(...args);
const resolveSignalIngressEventId = (
  ...args: Parameters<typeof signalIngressTesting.resolveSignalIngressEventId>
) => signalIngressTesting.resolveSignalIngressEventId(...args);
const resolveSignalIngressLaneKey = (
  ...args: Parameters<typeof signalIngressTesting.resolveSignalIngressLaneKey>
) => signalIngressTesting.resolveSignalIngressLaneKey(...args);

function signalEvent(params?: {
  senderNumber?: string;
  senderUuid?: string;
  timestamp?: number;
  groupId?: string;
  message?: string;
}): SignalSseEvent {
  const timestamp = params?.timestamp ?? 1_700_000_000_001;
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: params?.senderNumber ?? "+15550001111",
        ...(params?.senderUuid ? { sourceUuid: params.senderUuid } : {}),
        timestamp,
        dataMessage: {
          timestamp,
          message: params?.message ?? "hello",
          ...(params?.groupId ? { groupInfo: { groupId: params.groupId } } : {}),
        },
      },
    }),
  };
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<SignalIngressPayload>, stateDir: string) => Promise<T>,
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
  clearSignalRuntimeForTest();
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
      } satisfies ChannelIngressQueue<SignalIngressPayload>;
      setSignalRuntime({
        state: { openChannelIngressQueue: () => failingQueue },
      } as unknown as PluginRuntime);
      const dispatch = vi.fn();
      const monitor = await startSignalIngressMonitor({
        accountId: "default",
        dispatch,
        runtime: { error: vi.fn(), log: vi.fn() },
        runTrackedTask: vi.fn(),
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
      await enqueueSignalIngressEvent({ queue, event });

      const dispatch = vi.fn().mockResolvedValue(undefined);
      const recoveredDrain = createSignalIngressDrain({ queue, dispatch });
      await recoveredDrain.drainOnce();
      await recoveredDrain.waitForIdle();
      recoveredDrain.dispose();

      const restartedDrain = createSignalIngressDrain({ queue, dispatch });
      await restartedDrain.drainOnce();
      await restartedDrain.waitForIdle();
      restartedDrain.dispose();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith(event, expect.any(Object));
    });
  });

  it("keeps a completion tombstone so a duplicate cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const event = signalEvent();
      const first = await enqueueSignalIngressEvent({ queue, event });
      expect(first.kind).toBe("accepted");

      const dispatch = vi.fn().mockResolvedValue(undefined);
      const drain = createSignalIngressDrain({ queue, dispatch });
      await drain.drainOnce();
      await drain.waitForIdle();

      const duplicate = await enqueueSignalIngressEvent({ queue, event });
      expect(duplicate.kind).toBe("completed");
      await drain.drainOnce();
      await drain.waitForIdle();
      drain.dispose();

      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("completes only when deferred dispatch adoption becomes durable", async () => {
    await withQueue(async (queue) => {
      const event = signalEvent();
      await enqueueSignalIngressEvent({ queue, event });
      let adopt: (() => void | Promise<void>) | undefined;
      const drain = createSignalIngressDrain({
        queue,
        dispatch: (_event, lifecycle) => {
          adopt = lifecycle.onAdopted;
          lifecycle.onDeferred();
          return { kind: "deferred" };
        },
      });

      await drain.drainOnce();
      await vi.waitFor(async () => {
        expect(await queue.listClaims()).toHaveLength(1);
      });
      expect((await enqueueSignalIngressEvent({ queue, event })).kind).toBe("claimed");

      await adopt?.();
      await drain.waitForIdle();
      expect((await enqueueSignalIngressEvent({ queue, event })).kind).toBe("completed");
      drain.dispose();
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
      const drain = createSignalIngressDrain({ queue, dispatch });

      await drain.drainOnce();
      await drain.waitForIdle();

      expect((await queue.enqueue("malformed-event", {} as SignalIngressPayload)).kind).toBe(
        "failed",
      );
      expect(dispatch).not.toHaveBeenCalled();
      drain.dispose();
    });
  });

  it("dedupes a concrete Signal redelivery by sender and timestamp", async () => {
    await withQueue(async (queue) => {
      const original = signalEvent({
        senderNumber: "+15550002222",
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
        timestamp: 1_700_000_000_099,
        message: "redelivered message",
      });
      const redelivery = signalEvent({
        senderNumber: "+15550002222",
        senderUuid: "123e4567-e89b-12d3-a456-426614174000",
        timestamp: 1_700_000_000_099,
        message: "redelivered message",
      });
      expect(resolveSignalIngressEventId(original)).toBe(resolveSignalIngressEventId(redelivery));

      await enqueueSignalIngressEvent({ queue, event: original });
      const dispatch = vi.fn().mockResolvedValue(undefined);
      const drain = createSignalIngressDrain({ queue, dispatch });
      await drain.drainOnce();
      await drain.waitForIdle();

      const duplicate = await enqueueSignalIngressEvent({ queue, event: redelivery });
      expect(duplicate.kind).toBe("completed");
      await drain.drainOnce();
      await drain.waitForIdle();
      drain.dispose();

      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  it("uses a direct-sender or group-conversation lane and stores the raw event", async () => {
    await withQueue(async (queue) => {
      const direct = signalEvent({ senderUuid: "123e4567-e89b-12d3-a456-426614174000" });
      const group = signalEvent({ groupId: "group-123" });

      expect(resolveSignalIngressLaneKey(direct)).toBe(
        "direct:uuid:123e4567-e89b-12d3-a456-426614174000",
      );
      expect(resolveSignalIngressLaneKey(group)).toBe("group:group-123");

      await enqueueSignalIngressEvent({ queue, event: group });
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.payload.event).toEqual(group);
      expect(pending[0]?.laneKey).toBe("group:group-123");
    });
  });

  it.each([
    ["sync", { envelope: { sourceNumber: "+15550001111", timestamp: 1, syncMessage: {} } }],
    ["receipt", { envelope: { sourceNumber: "+15550001111", timestamp: 2, receiptMessage: {} } }],
    ["typing", { envelope: { sourceNumber: "+15550001111", timestamp: 3, typingMessage: {} } }],
  ])("does not journal %s envelopes", async (_label, payload) => {
    await withQueue(async (queue) => {
      const result = await enqueueSignalIngressEvent({
        queue,
        event: { event: "receive", data: JSON.stringify(payload) },
      });
      expect(result.kind).toBe("ignored");
      await expect(queue.listPending({ limit: "all" })).resolves.toHaveLength(0);
    });
  });
});
