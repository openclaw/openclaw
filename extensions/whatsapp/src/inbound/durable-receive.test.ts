import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WAMessage } from "baileys";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serializeWhatsAppDurableInboundMessage } from "./durable-payload.js";
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
let stateDir: string;
let currentTime: number | undefined;
let queue: ReturnType<typeof createChannelIngressQueueForTests<Payload>>;
const monitors: ReturnType<typeof createWhatsAppIngressMonitor>[] = [];
function monitor(dispatch: Parameters<typeof createWhatsAppIngressMonitor>[0]["dispatch"]) {
  const result = createWhatsAppIngressMonitor({ queue, pollIntervalMs: 10, dispatch });
  monitors.push(result);
  result.start();
  return result;
}
function enqueue(id: string, receivedAt?: number) {
  return queue.enqueue(
    eventId(id),
    {
      message: serializeWhatsAppDurableInboundMessage(message(id)),
      receivedAt: 1,
    },
    { laneKey: JID, receivedAt },
  );
}
const completed = (id: string) => expect(enqueue(id)).resolves.toMatchObject({ kind: "completed" });
const pending = () => queue.listPending({ limit: "all" });
const claims = async () => (await queue.listClaims()).map((row) => row.id).toSorted();
const transportId = (inbound: WhatsAppIngressAdmission) => inbound.message.key.id ?? "<missing>";
beforeEach(async () => {
  currentTime = undefined;
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  queue = createChannelIngressQueueForTests<Payload>({
    channelId: "whatsapp",
    accountId: "acct",
    stateDir,
    now: () => currentTime ?? Date.now(),
  });
});
afterEach(async () => {
  for (const active of monitors.splice(0)) {
    await active.stop();
  }
  await fs.rm(stateDir, { recursive: true, force: true });
});

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
it("orders debounced messages before adopting claims and marking read", async () => {
  const ids = ["first", "second", "third"];
  const adopted: string[] = [];
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
      turnAdoptionLifecycle: {
        ...lifecycle,
        onAdopted: async () => {
          await lifecycle.onAdopted();
          await lifecycle.onAdopted();
          adopted.push(id);
          expect(await claims()).toEqual(ids.slice(adopted.length).map(eventId).toSorted());
          await completed(id);
        },
      },
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
    expect(await claims()).toEqual(ids.map(eventId).toSorted());
    expect(await pending()).toEqual([]);
    expect(markRead).not.toHaveBeenCalled();
    await debouncer.drain();
    await active.waitForIdle();
    expect(bodies).toEqual(["first\nsecond\nthird"]);
    expect(markRead.mock.calls).toEqual(ids.map((id) => [{ remoteJid: JID, id }]));
    expect(onError).not.toHaveBeenCalled();
    expect(await claims()).toEqual([]);
    expect(adopted).toEqual(ids);
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
  const ids = Array.from({ length: count }, (_, index) => `msg-${String(index).padStart(3, "0")}`);
  for (const [index, id] of ids.entries()) {
    await enqueue(id, count === 1 ? old : index + 1);
  }
  const dispatched: string[] = [];
  await monitor(async (inbound) => {
    dispatched.push(transportId(inbound));
    return { kind: "completed" };
  }).waitForIdle();
  expect(dispatched.toSorted()).toEqual(ids.toSorted());
  expect(await pending()).toEqual([]);
});
