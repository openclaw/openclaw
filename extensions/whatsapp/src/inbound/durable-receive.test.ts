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
import { createWhatsAppIngressMonitor, type WhatsAppIngressAdmission } from "./durable-receive.js";
import { resolveWhatsAppIngressLifecycle } from "./ingress-lifecycle.js";
import { createWhatsAppInboundMessageDebouncer } from "./message-debounce.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

type WhatsAppDurableInboundPayload = Omit<WhatsAppIngressAdmission, "message"> & {
  message: ReturnType<typeof serializeWhatsAppDurableInboundMessage>;
};

const REMOTE_JID = "1@s.whatsapp.net";

async function withQueue<T>(
  fn: (queue: ReturnType<typeof createQueue>) => Promise<T>,
  now?: () => number,
): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  try {
    return await fn(createQueue(stateDir, now));
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

function createMonitor(
  queue: ReturnType<typeof createQueue>,
  options: Omit<Parameters<typeof createWhatsAppIngressMonitor>[0], "queue" | "pollIntervalMs">,
) {
  return createWhatsAppIngressMonitor({ queue, pollIntervalMs: 10, ...options });
}

function getTransportId(inbound: { message: WAMessage }) {
  const id = inbound.message.key.id;
  if (!id) {
    throw new Error("expected transport id");
  }
  return id;
}

async function drainToIds(queue: ReturnType<typeof createQueue>) {
  const dispatched: string[] = [];
  const monitor = createMonitor(queue, {
    dispatch: async (inbound) => {
      dispatched.push(getTransportId(inbound));
      return { kind: "completed" };
    },
  });
  monitor.start();
  await monitor.waitForIdle();
  await monitor.stop();
  return dispatched;
}

describe("createWhatsAppIngressMonitor", () => {
  it("rejects messages without a native id as a permanent ingress failure", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue, {
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
    await withQueue(async (queue) => {
      const id = eventId("msg-1");
      await queue.enqueue(id, payload("msg-1"), { laneKey: REMOTE_JID });

      const monitor = createMonitor(queue, {
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

  it("delivers same-lane debounce candidates while retaining each claim until adoption", async () => {
    await withQueue(async (queue) => {
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
      const monitor = createMonitor(queue, {
        dispatch: async (inbound, lifecycle) => {
          const id = getTransportId(inbound);
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
    await withQueue(async (queue) => {
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
      const monitor = createMonitor(queue, {
        dispatch: async (inbound, lifecycle) => {
          const id = getTransportId(inbound);
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
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1_000;
    await withQueue(
      async (queue) => {
        await queue.enqueue(eventId("msg-old"), payload("msg-old"), {
          laneKey: REMOTE_JID,
          receivedAt: thirtyOneDaysAgo,
        });

        const dispatched = await drainToIds(queue);

        expect(dispatched).toEqual(["msg-old"]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      },
      () => thirtyOneDaysAgo,
    );
  });

  it("dispatches every accepted pending record past the legacy 450-entry cap", async () => {
    await withQueue(async (queue) => {
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

      const dispatched = await drainToIds(queue);

      expect(dispatched.toSorted()).toEqual(transportIds.toSorted());
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
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
});
