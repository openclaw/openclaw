// WhatsApp durable ingress drain adapter: completion, retry, and lane serialization.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  deserializeWhatsAppDurableInboundMessage,
  serializeWhatsAppDurableInboundMessage,
} from "./durable-payload.js";
import { createWhatsAppIngressMonitor } from "./durable-receive.js";
import { resolveWhatsAppIngressLifecycle } from "./ingress-lifecycle.js";
import { createWhatsAppInboundMessageDebouncer } from "./message-debounce.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

type WhatsAppDurableInboundPayload = {
  message: ReturnType<typeof serializeWhatsAppDurableInboundMessage>;
  upsertType?: string;
  skipStaleAppend?: boolean;
  skipRecentOutboundEcho?: boolean;
  receivedAt: number;
  receiveOrder?: number;
};

const REMOTE_JID = "1@s.whatsapp.net";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function message(id: string, remoteJid = REMOTE_JID): WAMessage {
  return {
    key: { remoteJid, id, fromMe: false },
    message: { conversation: "hi" },
  };
}

function eventId(id: string, remoteJid = REMOTE_JID): string {
  return createHash("sha256").update(`${remoteJid}\n${id}`).digest("hex");
}

function payload(id: string, remoteJid = REMOTE_JID): WhatsAppDurableInboundPayload {
  return {
    message: serializeWhatsAppDurableInboundMessage(message(id, remoteJid)),
    receivedAt: 1,
  };
}

function createQueue(stateDir: string, now?: () => number) {
  return createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
    channelId: "whatsapp",
    accountId: "acct",
    stateDir,
    ...(now ? { now } : {}),
  });
}

describe("createWhatsAppIngressMonitor", () => {
  it("rejects messages without a native id as a permanent ingress failure", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({ kind: "completed" }),
      });
      monitor.start();
      const missingIdMessage = {
        ...message("unused"),
        key: { remoteJid: REMOTE_JID, fromMe: false },
      } as WAMessage;

      await expect(
        monitor.admit({ message: missingIdMessage, receivedAt: 1 }, { receivedAt: 1 }),
      ).rejects.toMatchObject({
        name: "WhatsAppIngressPermanentError",
        reason: "missing-message-key",
      });
      await monitor.stop();
    });
  });

  it("releases claims when dispatch throws before adoption", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);
      const id = eventId("msg-1");
      await queue.enqueue(id, payload("msg-1"), { laneKey: REMOTE_JID });

      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => {
          throw new Error("downstream callback rejected");
        },
      });

      monitor.start();
      await monitor.waitForIdle();

      const status = await queue.enqueue(id, payload("msg-1"), { laneKey: REMOTE_JID });
      expect(status.kind).not.toBe("completed");
      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === id)).toBe(true);
      await monitor.stop();
    });
  });

  it("propagates failed-retryable results as claim release", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);
      const id = eventId("msg-2");
      await queue.enqueue(id, payload("msg-2"), { laneKey: REMOTE_JID });

      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({
          kind: "failed-retryable",
          error: new Error("downstream flush rejected"),
        }),
      });

      monitor.start();
      await monitor.waitForIdle();

      const pending = await queue.listPending({ limit: "all" });
      const row = pending.find((entry) => entry.id === id);
      expect(row).toBeDefined();
      expect((row?.attempts ?? 0) >= 1).toBe(true);
      await monitor.stop();
    });
  });

  it("tombstones after an explicit completed dispatch", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);
      const id = eventId("msg-3");
      await queue.enqueue(id, payload("msg-3"), { laneKey: REMOTE_JID });

      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({ kind: "completed" }),
      });

      monitor.start();
      await monitor.waitForIdle();

      const status = await queue.enqueue(id, payload("msg-3"), { laneKey: REMOTE_JID });
      expect(status.kind).toBe("completed");
      await monitor.stop();
    });
  });

  it("delivers same-lane debounce candidates while retaining each claim until adoption", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);
      const firstId = eventId("msg-4a");
      const secondId = eventId("msg-4b");
      await queue.enqueue(firstId, payload("msg-4a"), {
        laneKey: REMOTE_JID,
        receivedAt: 1,
      });
      await queue.enqueue(secondId, payload("msg-4b"), {
        laneKey: REMOTE_JID,
        receivedAt: 2,
      });

      const dispatched: string[] = [];
      const adoptions: Array<() => void | Promise<void>> = [];
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (inbound, lifecycle) => {
          const id = inbound.message.key.id;
          if (!id) {
            throw new Error("expected transport id");
          }
          dispatched.push(id);
          adoptions.push(lifecycle.onAdopted);
          return { kind: "deferred" as const };
        },
      });

      monitor.start();
      await monitor.waitForIdle();

      try {
        expect(dispatched).toEqual(["msg-4a", "msg-4b"]);
        expect((await queue.listClaims()).map((row) => row.id).toSorted()).toEqual(
          [firstId, secondId].toSorted(),
        );
        expect(await queue.listPending({ limit: "all" })).toEqual([]);

        const [adoptFirst, adoptSecond] = adoptions;
        if (!adoptFirst || !adoptSecond) {
          throw new Error("expected both adoption callbacks");
        }
        await adoptFirst();
        await adoptFirst();
        expect((await queue.listClaims()).map((row) => row.id)).toEqual([secondId]);
        await expect(queue.enqueue(firstId, payload("msg-4a"))).resolves.toMatchObject({
          kind: "completed",
        });
        await adoptSecond();
        await adoptSecond();
        expect(await queue.listClaims()).toEqual([]);
        await expect(queue.enqueue(secondId, payload("msg-4b"))).resolves.toMatchObject({
          kind: "completed",
        });
        expect(dispatched).toEqual(["msg-4a", "msg-4b"]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("combines durable same-chat messages in timestamp and receive order before settling claims", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<WhatsAppDurableInboundPayload>({
        channelId: "whatsapp",
        accountId: "acct",
        stateDir,
      });
      const bodies: string[] = [];
      const markRead = vi.fn(async () => {});
      const onError = vi.fn();
      const debouncer = createWhatsAppInboundMessageDebouncer({
        resolveDebounceMs: () => 60_000,
        onMessage: async (msg) => {
          bodies.push(msg.payload.body);
          await resolveWhatsAppIngressLifecycle(msg)?.onAdopted();
        },
        markRead,
        onPendingWorkChanged: () => {},
        onError,
      });
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (inbound, lifecycle) => {
          const id = inbound.message.key.id;
          if (!id) {
            throw new Error("expected transport id");
          }
          await debouncer.enqueue({
            ...createTestWebInboundMessage({
              event: { id, timestamp: Number(inbound.message.messageTimestamp) },
              payload: { body: id },
              admission: { conversation: { id: REMOTE_JID } },
            }),
            receiveOrder: inbound.receiveOrder,
            turnAdoptionLifecycle: lifecycle,
            readReceipt: { remoteJid: REMOTE_JID, id },
          });
          return { kind: "deferred" };
        },
      });
      monitor.start();
      try {
        for (const [id, timestamp, receiveOrder] of [
          ["third", 2, 3],
          ["second", 1, 2],
          ["first", 1, 1],
        ] as const) {
          await monitor.admit({
            message: { ...message(id), messageTimestamp: timestamp },
            receiveOrder,
            receivedAt: Date.now(),
          });
        }
        await monitor.waitForIdle();
        expect(bodies).toEqual([]);
        expect(await queue.listClaims()).toHaveLength(3);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(markRead).not.toHaveBeenCalled();
        await debouncer.drain();
        await monitor.waitForIdle();
        expect(bodies).toEqual(["first\nsecond\nthird"]);
        expect(markRead.mock.calls).toEqual(
          ["first", "second", "third"].map((id) => [{ remoteJid: REMOTE_JID, id }]),
        );
        expect(onError).not.toHaveBeenCalled();
        expect(await queue.listClaims()).toEqual([]);
        for (const id of ["first", "second", "third"]) {
          await expect(queue.enqueue(eventId(id), payload(id))).resolves.toMatchObject({
            kind: "completed",
          });
        }
      } finally {
        await monitor.pause();
        await debouncer.drain();
        await monitor.stop();
      }
    });
  });

  it("dispatches accepted pending records older than the legacy 30-day TTL", async () => {
    await withTempState(async (stateDir) => {
      const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1_000;
      const queue = createQueue(stateDir, () => thirtyOneDaysAgo);
      await queue.enqueue(eventId("msg-old"), payload("msg-old"), {
        laneKey: REMOTE_JID,
        receivedAt: thirtyOneDaysAgo,
      });

      const dispatched: string[] = [];
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (admission) => {
          const id = admission.message.key.id;
          if (!id) {
            throw new Error("expected transport id");
          }
          dispatched.push(id);
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect(dispatched).toEqual(["msg-old"]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
    });
  });

  it("dispatches every accepted pending record past the legacy 450-entry cap", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);
      const transportIds = Array.from(
        { length: 451 },
        (_unused, index) => `msg-${String(index).padStart(3, "0")}`,
      );
      for (const [index, transportId] of transportIds.entries()) {
        await queue.enqueue(eventId(transportId), payload(transportId), {
          laneKey: REMOTE_JID,
          receivedAt: index + 1,
        });
      }

      const dispatched: string[] = [];
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (admission) => {
          const id = admission.message.key.id;
          if (!id) {
            throw new Error("expected transport id");
          }
          dispatched.push(id);
          return { kind: "completed" };
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect(dispatched.toSorted()).toEqual(transportIds.toSorted());
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
    });
  });

  it("keeps completed and failed replay guards bounded", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);
      const prune = vi.spyOn(queue, "prune");
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async () => ({ kind: "completed" }),
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect(prune).toHaveBeenCalledWith({
        completedTtlMs: 7 * 24 * 60 * 60 * 1_000,
        completedMaxEntries: 5_000,
        failedTtlMs: 30 * 24 * 60 * 60 * 1_000,
        failedMaxEntries: 450,
        now: expect.any(Number),
      });
    });
  });
});

describe("WhatsApp durable message serialization", () => {
  it("preserves Long-like protobuf timestamps as seconds", () => {
    const timestamp = 1_700_000_000;
    const longLike = { low: timestamp, high: 0, unsigned: true, valueOf: () => timestamp };
    const serialized = serializeWhatsAppDurableInboundMessage({
      ...message("long-timestamp"),
      messageTimestamp: longLike,
    } as unknown as WAMessage);

    expect(deserializeWhatsAppDurableInboundMessage(serialized).messageTimestamp).toBe(timestamp);
  });

  it("carries receive-time skip decisions through admission and replay", async () => {
    await withTempState(async (stateDir) => {
      const queue = createQueue(stateDir);

      const dispatched: Array<{
        upsertType?: string;
        skipStaleAppend?: boolean;
        skipRecentOutboundEcho?: boolean;
        receiveOrder?: number;
      }> = [];
      const monitor = createWhatsAppIngressMonitor({
        queue,
        pollIntervalMs: 10,
        dispatch: async (admission) => {
          dispatched.push(admission);
          return { kind: "completed" };
        },
      });
      monitor.start();
      await expect(
        monitor.admit(
          {
            message: message("stale-append"),
            upsertType: "append",
            skipStaleAppend: true,
            skipRecentOutboundEcho: true,
            receivedAt: 1,
            receiveOrder: 7,
          },
          { receivedAt: 1 },
        ),
      ).resolves.toMatchObject({ kind: "durable", queueResult: { kind: "accepted" } });
      await monitor.waitForIdle();

      expect(dispatched).toEqual([
        expect.objectContaining({
          upsertType: "append",
          skipStaleAppend: true,
          skipRecentOutboundEcho: true,
          receivedAt: 1,
          receiveOrder: 7,
        }),
      ]);
      await monitor.stop();
    });
  });
});
