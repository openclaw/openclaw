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

async function enqueue(queue: ReturnType<typeof createQueue>, id: string, receivedAt?: number) {
  await queue.enqueue(eventId(id), payload(id), { laneKey: REMOTE_JID, receivedAt });
}

async function expectCompleted(queue: ReturnType<typeof createQueue>, ids: string[]) {
  for (const id of ids) {
    await expect(queue.enqueue(eventId(id), payload(id))).resolves.toMatchObject({
      kind: "completed",
    });
  }
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
      await enqueue(queue, "msg-1");

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
      await enqueue(queue, "msg-4a", 1);
      await enqueue(queue, "msg-4b", 2);

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

        expect(adoptions).toHaveLength(2);
        for (const [index, adopt] of adoptions.entries()) {
          await adopt();
          await adopt();
          expect((await queue.listClaims()).map((row) => row.id)).toEqual(
            index === 0 ? [secondId] : [],
          );
          await expectCompleted(queue, [index === 0 ? "msg-4a" : "msg-4b"]);
        }
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
        await expectCompleted(queue, ["first", "second", "third"]);
      } finally {
        await monitor.pause();
        await debouncer.drain();
        await monitor.stop();
      }
    });
  });

  it.each([
    ["older than the legacy 30-day TTL", 1],
    ["past the legacy 450-entry cap", 451],
  ] as const)("dispatches all accepted records %s", async (_name, count) => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1_000;
    const transportIds = Array.from(
      { length: count },
      (_, index) => `msg-${String(index).padStart(3, "0")}`,
    );
    await withQueue(
      async (queue) => {
        for (const [index, id] of transportIds.entries()) {
          await enqueue(queue, id, count === 1 ? thirtyOneDaysAgo : index + 1);
        }
        expect((await drainToIds(queue)).toSorted()).toEqual(transportIds.toSorted());
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      },
      count === 1 ? () => thirtyOneDaysAgo : undefined,
    );
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
