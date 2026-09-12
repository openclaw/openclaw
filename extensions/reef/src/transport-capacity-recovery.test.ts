// Real-behavior proof for capacity-parked inbound delivery: the production
// ReefInboxConnection drives the production ReefMessageFlow over production
// SQLite delivered/replay stores, with only the relay and the platform send
// mocked out. Covers shared-inbox survival, later-entry processing, recovery
// once capacity frees, interrupted-delivery restart, and legacy marker
// interpretation.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeOutbound, generateIdentity, MemoryAuditStore } from "../protocol/index.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
  transport,
  trust,
} from "./flow.test-helpers.js";
import {
  REEF_DELIVERED_MAX_ENTRIES,
  REEF_DELIVERED_NAMESPACE,
  REEF_DELIVERED_TTL_MS,
  openStores,
} from "./state.js";
import { ReefInboxConnection, type ReefTransportClient } from "./transport.js";
import { createClient, parseRequestUrl } from "./transport.test-helpers.js";
import type { InboxEntry, ReefKeys } from "./types.js";

const ts = Math.floor(Date.now() / 1_000);

// A fresh runtime over the same persisted state directory: new store handles,
// same SQLite database — the production restart shape.
function reopenRuntime(stateDir: string) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return runtime;
}

async function envelopeFrom(
  sender: ReturnType<typeof generateIdentity>,
  senderHandle: string,
  recipient: ReefKeys,
  id: string,
  text: string,
) {
  return (
    await composeOutbound({
      id,
      from: `${senderHandle}#1`,
      to: "bob#1",
      body: { text },
      senderSigningSecretKey: sender.signing.secretKey,
      recipientEncryptionPublicKey: recipient.encryption.publicKey,
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(3)),
      policyVersion: "v1",
    })
  ).envelope;
}

function messageEntry(seq: number, peer: string, envelope: unknown, id: string): InboxEntry {
  return {
    seq,
    peer,
    id,
    kind: "message",
    envelope: envelope as InboxEntry["envelope"],
    ts,
  };
}

function relayRetaining(entries: Map<number, InboxEntry>) {
  const requestedAfter: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const after = Number(parseRequestUrl(input).searchParams.get("after"));
    requestedAfter.push(after);
    const page = [...entries.values()]
      .filter((entry) => entry.seq > after)
      .toSorted((left, right) => left.seq - right.seq);
    return Response.json({ entries: page, cursor: page.at(-1)?.seq ?? after });
  });
  return { fetcher, requestedAfter };
}

describe("Reef capacity-parked delivery recovery (production connection path)", () => {
  beforeEach(() => {
    resetFlowStoresForTests();
  });

  afterEach(() => {
    resetFlowStoresForTests();
  });

  it("survives delivered-capacity parks from two peers, keeps later entries attemptable, and completes both once capacity frees", async () => {
    const alice = generateIdentity();
    const carol = generateIdentity();
    const bob = reefKeys();
    const idA = "01JZ00000000000000000002A1";
    const idC = "01JZ00000000000000000002C1";
    const stores = flowStores(2);
    await stores.delivered.add("occupied-1");
    await stores.delivered.add("occupied-2");

    const entries = new Map<number, InboxEntry>([
      [1, messageEntry(1, "alice", await envelopeFrom(alice, "alice", bob, idA, "first"), idA)],
      [2, messageEntry(2, "carol", await envelopeFrom(carol, "carol", bob, idC, "second"), idC)],
    ]);
    const { fetcher } = relayRetaining(entries);
    const relay = transport();
    const onIngress = vi.fn(async () => {});
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice), carol: peerTrust(carol) }).store,
      keys: bob,
      transport: relay as unknown as ReefTransportClient, // SAFETY: ack-recording mock satisfies the client contract
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(30)),
      replay: openStores(stores.runtime, reefKeys(), { deliveredMaxEntries: 2 }).replay,
      ...stores,
      onIngress,
      onOwnerNotice: async () => {},
    });
    const persisted: number[] = [];
    const inbox = new ReefInboxConnection(
      createClient(fetcher),
      async (batch) => {
        await flow.processEntries(batch);
      },
      () => {
        throw new Error("REST-only proof: no live socket expected");
      },
      { initialCursor: 0, persistCursor: (cursor) => persisted.push(cursor) },
    );

    // Delivered namespace full: both entries park AFTER ingress as retry-safe
    // domain states when confirmation reaches capacity. The shared connection
    // survives without retaining per-entry reservation bookkeeping, later entries are still
    // attempted, nothing is acknowledged, and the cursor is held.
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(2);
    expect(relay.acknowledge).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);

    // Capacity frees (marker TTL expiry in production; explicit free here).
    const raw = stores.runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: 2,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
    raw.delete("occupied-1");
    raw.delete("occupied-2");

    // Re-poll: both parked entries complete in order, re-ingressing once more
    // (bounded at-least-once), confirming markers, acknowledging, and
    // persisting a cursor past both.
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(4);
    expect(relay.acknowledge).toHaveBeenCalledTimes(2);
    await expect(stores.delivered.status(idA)).resolves.toBe("delivered");
    await expect(stores.delivered.status(idC)).resolves.toBe("delivered");
    expect(persisted.at(-1)).toBe(2);

    // A third poll is fully drained: nothing re-dispatches.
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(4);
    expect(relay.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("an interrupted delivery before ingress re-ingresses exactly once and confirms on restart", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const id = "01JZ00000000000000000002D1";
    const stores = flowStores();
    // Crash window: inbound handling had not run, so no in-flight record
    // exists; the restart re-classifies the entry from persisted markers and
    // re-ingresses exactly once.
    const entries = new Map<number, InboxEntry>([
      [1, messageEntry(1, "alice", await envelopeFrom(alice, "alice", bob, id, "resumed"), id)],
    ]);
    const { fetcher } = relayRetaining(entries);
    const relay = transport();
    const onIngress = vi.fn(async () => {});
    // Restart: a fresh flow over freshly opened store handles for the same
    // persisted state directory (production SQLite replay and delivered stores).
    const reopened = openStores(reopenRuntime(stores.stateDir), reefKeys());
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice) }).store,
      keys: bob,
      transport: relay as unknown as ReefTransportClient, // SAFETY: ack-recording mock satisfies the client contract
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(31)),
      replay: reopened.replay,
      reviews: reopened.reviews,
      delivered: reopened.delivered,
      onIngress,
      onOwnerNotice: async () => {},
    });
    const persisted: number[] = [];
    const inbox = new ReefInboxConnection(
      createClient(fetcher),
      async (batch) => {
        await flow.processEntries(batch);
      },
      () => {
        throw new Error("REST-only proof: no live socket expected");
      },
      { initialCursor: 0, persistCursor: (cursor) => persisted.push(cursor) },
    );

    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(1);
    await expect(stores.delivered.status(id)).resolves.toBe("delivered");
    expect(relay.acknowledge).toHaveBeenCalledTimes(1);
    expect(persisted.at(-1)).toBe(1);

    // The relay re-sends the same envelope id under a new sequence (retained
    // backlog redelivery): the delivered marker suppresses re-ingress, ack only.
    entries.set(2, messageEntry(2, "alice", entries.get(1)!.envelope, id));
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(1);
    expect(relay.acknowledge).toHaveBeenCalledTimes(2);
    expect(persisted.at(-1)).toBe(2);
  });

  it("a crash after ingress re-dispatches once on restart when capacity had blocked confirm", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const id = "01JZ00000000000000000002E1";
    const stores = flowStores(1);
    await stores.delivered.add("occupied"); // delivered namespace full
    const entries = new Map<number, InboxEntry>([
      [1, messageEntry(1, "alice", await envelopeFrom(alice, "alice", bob, id, "crashed"), id)],
    ]);
    const { fetcher } = relayRetaining(entries);
    const relay = transport();
    const onIngress = vi.fn(async () => {});
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice) }).store,
      keys: bob,
      transport: relay as unknown as ReefTransportClient, // SAFETY: ack-recording mock satisfies the client contract
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(33)),
      replay: openStores(stores.runtime, reefKeys(), { deliveredMaxEntries: 1 }).replay,
      ...stores,
      onIngress,
      onOwnerNotice: async () => {},
    });
    const persisted: number[] = [];
    const inbox = new ReefInboxConnection(
      createClient(fetcher),
      async (batch) => {
        await flow.processEntries(batch);
      },
      () => {
        throw new Error("REST-only proof: no live socket expected");
      },
      { initialCursor: 0, persistCursor: (cursor) => persisted.push(cursor) },
    );

    // Capacity blocks confirm after ingress: the entry parks, un-acked.
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(1);
    expect(relay.acknowledge).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);

    // Restart: fresh flow over freshly opened handles for the same persisted
    // state directory. Capacity frees (marker TTL expiry in production;
    // explicit free here); the restart re-classifies the entry and
    // re-dispatches once — the documented bounded at-least-once trade.
    const raw = stores.runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
    raw.delete("occupied");
    const reopened = openStores(reopenRuntime(stores.stateDir), reefKeys(), {
      deliveredMaxEntries: 1,
    });
    const restartedFlow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice) }).store,
      keys: bob,
      transport: relay as unknown as ReefTransportClient, // SAFETY: ack-recording mock satisfies the client contract
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(34)),
      replay: reopened.replay,
      reviews: reopened.reviews,
      delivered: reopened.delivered,
      onIngress,
      onOwnerNotice: async () => {},
    });
    const restartedInbox = new ReefInboxConnection(
      createClient(fetcher),
      async (batch) => {
        await restartedFlow.processEntries(batch);
      },
      () => {
        throw new Error("REST-only proof: no live socket expected");
      },
      { initialCursor: 0, persistCursor: (cursor) => persisted.push(cursor) },
    );

    await restartedInbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(2);
    await expect(stores.delivered.status(id)).resolves.toBe("delivered");
    expect(relay.acknowledge).toHaveBeenCalledTimes(1);
    expect(persisted.at(-1)).toBe(1);
  });

  it("legacy stateless delivered markers suppress re-ingress and acknowledge on the next poll", async () => {
    const alice = generateIdentity();
    const bob = reefKeys();
    const id = "01JZ00000000000000000002E1";
    const stores = flowStores();
    const raw = stores.runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: REEF_DELIVERED_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
    raw.registerIfAbsent(id, { id });
    const entries = new Map<number, InboxEntry>([
      [1, messageEntry(1, "alice", await envelopeFrom(alice, "alice", bob, id, "legacy"), id)],
    ]);
    const { fetcher } = relayRetaining(entries);
    const relay = transport();
    const onIngress = vi.fn(async () => {});
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust({ alice: peerTrust(alice) }).store,
      keys: bob,
      transport: relay as unknown as ReefTransportClient, // SAFETY: ack-recording mock satisfies the client contract
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(32)),
      replay: openStores(stores.runtime, reefKeys()).replay,
      ...stores,
      onIngress,
      onOwnerNotice: async () => {},
    });
    const persisted: number[] = [];
    const inbox = new ReefInboxConnection(
      createClient(fetcher),
      async (batch) => {
        await flow.processEntries(batch);
      },
      () => {
        throw new Error("REST-only proof: no live socket expected");
      },
      { initialCursor: 0, persistCursor: (cursor) => persisted.push(cursor) },
    );

    await inbox.drain();
    expect(onIngress).not.toHaveBeenCalled();
    expect(relay.acknowledge).toHaveBeenCalledTimes(1);
    await expect(stores.delivered.status(id)).resolves.toBe("delivered");
    expect(persisted.at(-1)).toBe(1);
  });
});
