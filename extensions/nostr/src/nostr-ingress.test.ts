import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Event } from "nostr-tools";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateNostrLegacyRecentEventIds } from "./nostr-ingress-state.js";
import { createNostrIngress } from "./nostr-ingress.js";

type NostrIngressQueue = NonNullable<Parameters<typeof createNostrIngress>[0]["queue"]>;
type NostrIngressPayload = Parameters<NostrIngressQueue["enqueue"]>[1];
type IngressOptions = Parameters<typeof createNostrIngress>[0];
let queue: NostrIngressQueue;
let stateDir: string;
const activeIngress: ReturnType<typeof createNostrIngress>[] = [];

function createEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "1".repeat(64),
    kind: 4,
    pubkey: "a".repeat(64),
    content: "ciphertext",
    created_at: 1_710_000_000,
    tags: [["p", "b".repeat(64)]],
    sig: "2".repeat(128),
    ...overrides,
  };
}

function startIngress(params: Partial<IngressOptions> = {}) {
  const ingress = createNostrIngress({
    accountId: "default",
    queue,
    deliver: async (_event, lifecycle) => lifecycle.onDeferred(),
    afterDurableAppend: () => {},
    maxSerializedPayloadBytes: 128 * 1024,
    maxPendingEvents: 1_000,
    maxQueuedAdmissions: 1_000,
    admissionRateLimit: { windowMs: 60_000, maxEvents: 1_000 },
    onError: vi.fn(),
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
    ...params,
  });
  activeIngress.push(ingress);
  return ingress;
}

beforeEach(async () => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-ingress-"));
  stateDir = await fs.realpath(created);
  queue = createChannelIngressQueueForTests<NostrIngressPayload>({
    channelId: "nostr",
    accountId: "default",
    stateDir,
  });
});

afterEach(async () => {
  try {
    for (const ingress of activeIngress.splice(0).toReversed()) {
      await ingress.stop();
    }
  } finally {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

describe("Nostr durable ingress", () => {
  it("advances the cursor only after exact raw admission into the sender lane", async () => {
    let appendCommitted = false;
    const trackAppend = async <T>(work: Promise<T>): Promise<T> => {
      const result = await work;
      appendCommitted = true;
      return result;
    };
    const trackingQueue = {
      ...queue,
      enqueue: (...args) => trackAppend(queue.enqueue(...args)),
      enqueueAndClaim:
        queue.enqueueAndClaim && ((...args) => trackAppend(queue.enqueueAndClaim!(...args))),
    } satisfies NostrIngressQueue;
    const afterDurableAppend = vi.fn(() => {
      expect(appendCommitted).toBe(true);
    });
    const ingress = startIngress({ queue: trackingQueue, afterDurableAppend });
    const event = createEvent();
    await expect(ingress.receive(event)).resolves.toBe("accepted");
    await ingress.waitForIdle();
    expect(afterDurableAppend).toHaveBeenCalledWith(event);
    expect(await queue.listClaims()).toEqual([
      expect.objectContaining({
        id: event.id,
        laneKey: `direct:${event.pubkey}`,
        payload: expect.objectContaining({ rawEvent: JSON.stringify(event) }),
      }),
    ]);
  });

  it("recovers an uncompleted relay event with a fresh drain exactly once", async () => {
    const interrupted = startIngress();
    await interrupted.receive(createEvent({ id: "3".repeat(64) }));
    await interrupted.waitForIdle();
    expect(await queue.listClaims()).toHaveLength(1);
    await interrupted.stop();

    const recoveredDeliver = vi.fn<IngressOptions["deliver"]>(async (_event, lifecycle) =>
      lifecycle.onAdopted(),
    );
    const recovered = startIngress({ deliver: recoveredDeliver });
    await recovered.waitForIdle();
    expect(recoveredDeliver).toHaveBeenCalledTimes(1);
  });

  it("migrates the persisted LRU seed into completion tombstones", async () => {
    const legacyId = "5".repeat(64);
    await expect(
      migrateNostrLegacyRecentEventIds({ queue, eventIds: [legacyId, legacyId] }),
    ).resolves.toBe(1);
    expect((await queue.enqueue(legacyId, {} as NostrIngressPayload)).kind).toBe("completed");
  });

  it("isolates a malformed relay event from later admissions", async () => {
    const ingress = startIngress({
      deliver: async (_event, lifecycle) => lifecycle.onAdopted(),
    });
    await expect(ingress.receive({} as Event)).rejects.toThrow("missing id");
    const cyclic = createEvent({ id: "0".repeat(64) }) as Event & { extra?: unknown };
    cyclic.extra = cyclic;
    await expect(ingress.receive(cyclic)).rejects.toThrow(
      "could not be serialized for durable ingress",
    );
    await expect(ingress.receive(createEvent({ id: "f".repeat(64) }))).resolves.toBe("accepted");
  });

  it("latches the first append failure across queued admissions", async () => {
    const appendError = new Error("sqlite unavailable");
    const enqueue = vi.fn().mockRejectedValue(appendError);
    const failingQueue = {
      ...queue,
      enqueueAndClaim: undefined,
      enqueue,
    } satisfies NostrIngressQueue;
    const afterDurableAppend = vi.fn();
    const ingress = startIngress({ queue: failingQueue, deliver: vi.fn(), afterDurableAppend });
    const first = ingress.receive(createEvent({ id: "7".repeat(64) }));
    const queued = ingress.receive(createEvent({ id: "8".repeat(64) }));
    await expect(first).rejects.toThrow("Nostr durable admission failed");
    await expect(queued).rejects.toThrow("Nostr durable admission failed");
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(afterDurableAppend).not.toHaveBeenCalled();
  });

  it("charges rejected events to the admission budget before serialization work", async () => {
    const enqueue = vi.fn(queue.enqueue.bind(queue));
    const ingress = startIngress({
      queue: { ...queue, enqueue },
      deliver: vi.fn(),
      maxSerializedPayloadBytes: 600,
      admissionRateLimit: { windowMs: 60_000, maxEvents: 1 },
    });
    await expect(
      ingress.receive(createEvent({ id: "1".repeat(64), content: "\\".repeat(40) })),
    ).rejects.toThrow("exceeds the durable ingress size limit");
    await expect(ingress.receive(createEvent({ id: "2".repeat(64) }))).rejects.toThrow(
      "exceeds the durable admission rate",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("applies bounded backpressure without latching admission", async () => {
    const held = createEvent({ id: "c".repeat(64) });
    await queue.enqueue(
      held.id,
      { version: 1, receivedAt: Date.now(), rawEvent: JSON.stringify(held) },
      { laneKey: `direct:${held.pubkey}` },
    );
    const ingress = startIngress({ maxPendingEvents: 1 });
    await ingress.waitForIdle();
    await expect(ingress.receive(createEvent({ id: "d".repeat(64) }))).rejects.toThrow(
      "exceeds the durable ingress backlog",
    );

    const [heldClaim] = await queue.listClaims();
    if (!heldClaim) {
      throw new Error("expected held ingress claim");
    }
    await queue.complete(heldClaim);
    await expect(ingress.receive(createEvent({ id: "e".repeat(64) }))).resolves.toBe("accepted");
  });

  it("bounds the in-memory admission chain before queue I/O", async () => {
    const listGate = Promise.withResolvers<void>();
    const blockingQueue = {
      ...queue,
      listPending: vi.fn(async () => {
        await listGate.promise;
        return [];
      }),
    } satisfies NostrIngressQueue;
    const ingress = startIngress({
      queue: blockingQueue,
      maxQueuedAdmissions: 1,
      deliver: async (_event, lifecycle) => lifecycle.onAdopted(),
    });
    try {
      const first = ingress.receive(createEvent({ id: "3".repeat(64) }));
      await expect(ingress.receive(createEvent({ id: "4".repeat(64) }))).rejects.toThrow(
        "exceeds the in-memory admission backlog",
      );
      listGate.resolve();
      await expect(first).resolves.toBe("accepted");
    } finally {
      listGate.resolve();
      await ingress.stop();
    }
  });

  it("quiesces delivery before waiting for an in-flight admission", async () => {
    const enqueueGate = Promise.withResolvers<void>();
    const enqueueStarted = Promise.withResolvers<void>();
    const blockingQueue = {
      ...queue,
      enqueueAndClaim: undefined,
      enqueue: vi.fn(async (...args: Parameters<NostrIngressQueue["enqueue"]>) => {
        enqueueStarted.resolve();
        await enqueueGate.promise;
        return queue.enqueue(...args);
      }),
    } satisfies NostrIngressQueue;
    const deliver = vi.fn();
    const ingress = startIngress({ queue: blockingQueue, deliver });
    const admission = ingress.receive(createEvent({ id: "b".repeat(64) }));
    await enqueueStarted.promise;

    const stop = ingress.stop();
    enqueueGate.resolve();

    await expect(admission).resolves.toBe("accepted");
    await stop;
    expect(deliver).not.toHaveBeenCalled();
    await expect(ingress.receive(createEvent({ id: "c".repeat(64) }))).rejects.toThrow(
      "Nostr ingress stopped",
    );
  });
});
