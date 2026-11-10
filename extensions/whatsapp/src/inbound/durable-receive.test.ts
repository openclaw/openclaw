import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deserializeWhatsAppDurableInboundMessage,
  serializeWhatsAppDurableInboundMessage,
} from "./durable-payload.js";
import { createWhatsAppIngressMonitor, type WhatsAppIngressAdmission } from "./durable-receive.js";
import { resolveWhatsAppIngressLifecycle } from "./ingress-lifecycle.js";
import { createWhatsAppInboundMessageDebouncer } from "./message-debounce.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

type Payload = Omit<WhatsAppIngressAdmission, "message"> & {
  message: ReturnType<typeof serializeWhatsAppDurableInboundMessage>;
};
const JID = "1@s.whatsapp.net";
const message = (id: string): WAMessage => ({
  key: { remoteJid: JID, id, fromMe: false },
  message: { conversation: "hi" },
});
const eventId = (id: string) => createHash("sha256").update(`${JID}\n${id}`).digest("hex");
const payload = (id: string): Payload => ({
  message: serializeWhatsAppDurableInboundMessage(message(id)),
  receivedAt: 1,
});
let stateDir: string;
let currentTime: number | undefined;
let queue: ReturnType<typeof createQueue>;
const monitors: ReturnType<typeof createWhatsAppIngressMonitor>[] = [];
function createQueue() {
  return createChannelIngressQueueForTests<Payload>({
    channelId: "whatsapp",
    accountId: "acct",
    stateDir,
    now: () => currentTime ?? Date.now(),
  });
}
function monitor(dispatch: Parameters<typeof createWhatsAppIngressMonitor>[0]["dispatch"]) {
  const result = createWhatsAppIngressMonitor({ queue, pollIntervalMs: 10, dispatch });
  monitors.push(result);
  result.start();
  return result;
}
async function enqueue(id: string, receivedAt?: number) {
  await queue.enqueue(eventId(id), payload(id), { laneKey: JID, receivedAt });
}
async function completed(ids: string[]) {
  for (const id of ids) {
    await expect(queue.enqueue(eventId(id), payload(id))).resolves.toMatchObject({
      kind: "completed",
    });
  }
}
const transportId = (inbound: WhatsAppIngressAdmission) => {
  const id = inbound.message.key.id;
  if (!id) {
    throw new Error("expected transport id");
  }
  return id;
};
beforeEach(async () => {
  currentTime = undefined;
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  queue = createQueue();
});
afterEach(async () => {
  for (const active of monitors.splice(0)) {
    await active.stop();
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("WhatsApp durable receive", () => {
  it("rejects missing native IDs permanently", async () => {
    const active = monitor(async () => ({ kind: "completed" }));
    const missing = { ...message("unused"), key: { remoteJid: JID, fromMe: false } };
    await expect(
      active.admit({ message: missing, receivedAt: 1 }, { receivedAt: 1 }),
    ).rejects.toMatchObject({
      name: "WhatsAppIngressPermanentError",
      reason: "missing-message-key",
    });
  });
  it("releases claims when dispatch throws before adoption", async () => {
    await enqueue("msg-1");
    const active = monitor(async () => {
      throw new Error("downstream callback rejected");
    });
    await active.waitForIdle();
    expect(
      (await queue.enqueue(eventId("msg-1"), payload("msg-1"), { laneKey: JID })).kind,
    ).not.toBe("completed");
    expect(
      (await queue.listPending({ limit: "all" })).some((row) => row.id === eventId("msg-1")),
    ).toBe(true);
  });
  it("retains individual same-lane claims until idempotent adoption", async () => {
    const ids = ["msg-4a", "msg-4b"] as const;
    await enqueue(ids[0], 1);
    await enqueue(ids[1], 2);
    const dispatched: string[] = [];
    const adoptions: Array<() => void | Promise<void>> = [];
    const active = monitor(async (inbound, lifecycle) => {
      dispatched.push(transportId(inbound));
      adoptions.push(lifecycle.onAdopted);
      return { kind: "deferred" };
    });
    await active.waitForIdle();
    expect(dispatched).toEqual(ids);
    expect((await queue.listClaims()).map((row) => row.id).toSorted()).toEqual(
      ids.map(eventId).toSorted(),
    );
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(adoptions).toHaveLength(2);
    for (const [index, adopt] of adoptions.entries()) {
      await adopt();
      await adopt();
      expect((await queue.listClaims()).map((row) => row.id)).toEqual(
        index === 0 ? [eventId(ids[1])] : [],
      );
      await completed(ids.slice(index, index + 1));
    }
    expect(dispatched).toEqual(ids);
  });
  it("orders debounced messages before adopting claims and marking read", async () => {
    const bodies: string[] = [];
    const markRead = vi.fn(async () => {});
    const onError = vi.fn();
    const debouncer = createWhatsAppInboundMessageDebouncer({
      resolveDebounceMs: () => 60_000,
      markRead,
      onError,
      onPendingWorkChanged: () => {},
      onMessage: async (msg) => {
        bodies.push(msg.payload.body);
        await resolveWhatsAppIngressLifecycle(msg)?.onAdopted();
      },
    });
    const active = monitor(async (inbound, lifecycle) => {
      const id = transportId(inbound);
      await debouncer.enqueue({
        ...createTestWebInboundMessage({
          event: { id, timestamp: Number(inbound.message.messageTimestamp) },
          payload: { body: id },
          admission: { conversation: { id: JID } },
        }),
        receiveOrder: inbound.receiveOrder,
        turnAdoptionLifecycle: lifecycle,
        readReceipt: { remoteJid: JID, id },
      });
      return { kind: "deferred" };
    });
    try {
      for (const [id, timestamp, receiveOrder] of [
        ["third", 2, 3],
        ["second", 1, 2],
        ["first", 1, 1],
      ] as const) {
        await active.admit({
          message: { ...message(id), messageTimestamp: timestamp },
          receiveOrder,
          receivedAt: Date.now(),
        });
      }
      await active.waitForIdle();
      expect(bodies).toEqual([]);
      expect(await queue.listClaims()).toHaveLength(3);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(markRead).not.toHaveBeenCalled();
      await debouncer.drain();
      await active.waitForIdle();
      expect(bodies).toEqual(["first\nsecond\nthird"]);
      expect(markRead.mock.calls).toEqual(
        ["first", "second", "third"].map((id) => [{ remoteJid: JID, id }]),
      );
      expect(onError).not.toHaveBeenCalled();
      expect(await queue.listClaims()).toEqual([]);
      await completed(["first", "second", "third"]);
    } finally {
      await active.pause();
      await debouncer.drain();
    }
  });
  it.each([
    ["older than 30 days", 1],
    ["past 450 entries", 451],
  ] as const)("dispatches records %s", async (_name, count) => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1_000;
    currentTime = count === 1 ? old : undefined;
    const ids = Array.from(
      { length: count },
      (_, index) => `msg-${String(index).padStart(3, "0")}`,
    );
    for (const [index, id] of ids.entries()) {
      await enqueue(id, count === 1 ? old : index + 1);
    }
    const dispatched: string[] = [];
    await monitor(async (inbound) => {
      dispatched.push(transportId(inbound));
      return { kind: "completed" };
    }).waitForIdle();
    expect(dispatched.toSorted()).toEqual(ids.toSorted());
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
  });
  it("serializes Long-like protobuf timestamps as seconds", () => {
    const timestamp = 1_700_000_000;
    const serialized = serializeWhatsAppDurableInboundMessage({
      ...message("long-timestamp"),
      messageTimestamp: { low: timestamp, high: 0, unsigned: true, valueOf: () => timestamp },
    } as unknown as WAMessage);
    expect(deserializeWhatsAppDurableInboundMessage(serialized).messageTimestamp).toBe(timestamp);
  });
});
