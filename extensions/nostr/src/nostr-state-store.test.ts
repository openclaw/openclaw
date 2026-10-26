import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Event } from "nostr-tools";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateNostrLegacyRecentEventIds } from "./nostr-ingress-state.js";
import { createNostrIngress } from "./nostr-ingress.js";
import {
  computeSinceTimestamp,
  readNostrBusState,
  readNostrProfileState,
  writeNostrBusState,
  writeNostrProfileState,
} from "./nostr-state-store.js";
import { setNostrRuntime } from "./runtime.js";

type NostrIngressQueue = NonNullable<Parameters<typeof createNostrIngress>[0]["queue"]>;
type NostrIngressPayload = Parameters<NostrIngressQueue["enqueue"]>[1];
type IngressOptions = Parameters<typeof createNostrIngress>[0];
let queue: NostrIngressQueue;
let stateDir: string;
const activeIngress: ReturnType<typeof createNostrIngress>[] = [];

function createEvent(id = "1", overrides: Partial<Event> = {}): Event {
  return {
    id: id.repeat(64),
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
    ...params,
  });
  activeIngress.push(ingress);
  return ingress;
}

beforeEach(async () => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-nostr-ingress-"));
  stateDir = await fs.realpath(created);
  resetPluginStateStoreForTests();
  setNostrRuntime(
    createPluginRuntimeMock({
      state: {
        openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests<T>("nostr", {
            ...options,
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
      },
    }),
  );
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
    // Release cached handles before deleting SQLite files on Windows.
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

describe("Nostr state", () => {
  const writeBus = (
    accountId: string,
    lastProcessedAt: number,
    gatewayStartedAt = lastProcessedAt,
  ) => writeNostrBusState({ accountId, lastProcessedAt, gatewayStartedAt });
  it("isolates state by accountId", async () => {
    await writeBus("bot-a", 1000);
    await writeBus("bot-b", 2000);
    expect((await readNostrBusState({ accountId: "bot-a" }))?.lastProcessedAt).toBe(1000);
    expect((await readNostrBusState({ accountId: "bot-b" }))?.lastProcessedAt).toBe(2000);
  });
  it("preserves legacy account key bytes for state lookup", async () => {
    await writeBus(" Team.A ", 1234, 1200);
    await expect(readNostrBusState({ accountId: "Team.A" })).resolves.toMatchObject({
      lastProcessedAt: 1234,
    });
    await expect(readNostrBusState({ accountId: "team-a" })).resolves.toBeNull();
  });
  it("persists and reloads profile publish state", async () => {
    const profile = {
      lastPublishedAt: 1700000000,
      lastPublishedEventId: "evt-1",
      lastPublishResults: { "wss://relay.example": "ok" as const },
    };
    await writeNostrProfileState({ accountId: "test-bot", ...profile });
    expect(await readNostrProfileState({ accountId: "test-bot" })).toEqual({
      version: 1,
      ...profile,
    });
  });
  it.each([
    [null, 1700000000],
    [[1699999000, 1699998000], 1699999000],
    [[null, null], 1700000000],
  ] as const)("computes the resume timestamp from %j", (saved, expected) => {
    const state = saved && {
      version: 2 as const,
      lastProcessedAt: saved[0],
      gatewayStartedAt: saved[1],
      recentEventIds: [],
    };
    expect(computeSinceTimestamp(state, 1700000000)).toBe(expected);
  });
});

describe("Nostr durable ingress state", () => {
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
    await interrupted.receive(createEvent("3"));
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
    await migrateNostrLegacyRecentEventIds({ queue, eventIds: [legacyId, legacyId] });
    expect((await queue.enqueue(legacyId, {} as NostrIngressPayload)).kind).toBe("completed");
  });

  it("isolates a malformed relay event from later admissions", async () => {
    const ingress = startIngress({
      deliver: async (_event, lifecycle) => lifecycle.onAdopted(),
    });
    await expect(ingress.receive({} as Event)).rejects.toThrow("missing id");
    const cyclic = createEvent("0") as Event & { extra?: unknown };
    cyclic.extra = cyclic;
    await expect(ingress.receive(cyclic)).rejects.toThrow(
      "could not be serialized for durable ingress",
    );
    await expect(ingress.receive(createEvent("f"))).resolves.toBe("accepted");
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
    const first = ingress.receive(createEvent("7"));
    const queued = ingress.receive(createEvent("8"));
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
    await expect(ingress.receive(createEvent("1", { content: "\\".repeat(40) }))).rejects.toThrow(
      "exceeds the durable ingress size limit",
    );
    await expect(ingress.receive(createEvent("2"))).rejects.toThrow(
      "exceeds the durable admission rate",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns a duplicate event's slot to the admission window", async () => {
    const ingress = startIngress({ admissionRateLimit: { windowMs: 60_000, maxEvents: 2 } });
    await expect(ingress.receive(createEvent("1"))).resolves.toBe("accepted");
    await expect(ingress.receive(createEvent("1"))).resolves.toBe("duplicate");
    await expect(ingress.receive(createEvent("2"))).resolves.toBe("accepted");
  });

  it("applies bounded backpressure without latching admission", async () => {
    const held = createEvent("c");
    await queue.enqueue(
      held.id,
      { version: 1, receivedAt: Date.now(), rawEvent: JSON.stringify(held) },
      { laneKey: `direct:${held.pubkey}` },
    );
    const ingress = startIngress({ maxPendingEvents: 1 });
    await ingress.waitForIdle();
    await expect(ingress.receive(createEvent("d"))).rejects.toThrow(
      "exceeds the durable ingress backlog",
    );

    const [heldClaim] = await queue.listClaims();
    if (!heldClaim) {
      throw new Error("expected held ingress claim");
    }
    await queue.complete(heldClaim);
    await expect(ingress.receive(createEvent("e"))).resolves.toBe("accepted");
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
      const first = ingress.receive(createEvent("3"));
      await expect(ingress.receive(createEvent("4"))).rejects.toThrow(
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
    const admission = ingress.receive(createEvent("b"));
    await enqueueStarted.promise;

    const stop = ingress.stop();
    enqueueGate.resolve();

    await expect(admission).resolves.toBe("accepted");
    await stop;
    expect(deliver).not.toHaveBeenCalled();
    await expect(ingress.receive(createEvent("c"))).rejects.toThrow("Nostr ingress stopped");
  });
});
