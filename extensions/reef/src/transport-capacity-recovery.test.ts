import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeOutbound, generateIdentity } from "../protocol/index.js";
import { MemoryAuditStore } from "../protocol/memory-stores.test-support.js";
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
import type { InboxEntry } from "./types.js";

// New runtime and store handles over the same persisted database, as on restart.
function reopenRuntime(stateDir: string) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("reef", {
      ...options,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
  return runtime;
}

async function fixture(peers = ["alice"], deliveredMaxEntries = REEF_DELIVERED_MAX_ENTRIES) {
  const keys = reefKeys();
  const identities = peers.map((peer) => ({ peer, identity: generateIdentity() }));
  const entries = await Promise.all(
    identities.map(async ({ peer, identity }, index): Promise<InboxEntry> => {
      const seq = index + 1;
      const id = `01JZ${String(seq).padStart(22, "0")}`;
      const { envelope } = await composeOutbound({
        id,
        from: `${peer}#1`,
        to: "bob#1",
        body: { text: `message ${seq}` },
        senderSigningSecretKey: identity.signing.secretKey,
        recipientEncryptionPublicKey: keys.encryption.publicKey,
        guard: guard(allow),
        audit: new MemoryAuditStore(new Uint8Array(32).fill(3)),
        policyVersion: "v1",
      });
      return { seq, peer, id, kind: "message", envelope, ts: Math.floor(Date.now() / 1_000) };
    }),
  );
  const stores = flowStores(deliveredMaxEntries);
  const raw = stores.runtime.state.openSyncKeyedStore<{ id: string }>({
    namespace: REEF_DELIVERED_NAMESPACE,
    maxEntries: deliveredMaxEntries,
    overflowPolicy: "reject-new",
    defaultTtlMs: REEF_DELIVERED_TTL_MS,
  });
  const relay = transport();
  const onIngress = vi.fn(async () => {});
  const persisted: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const after = Number(parseRequestUrl(input).searchParams.get("after"));
    const page = entries.filter((entry) => entry.seq > after);
    return Response.json({ entries: page, cursor: page.at(-1)?.seq ?? after });
  });
  function connect(runtime = stores.runtime) {
    const { replay, reviews, delivered } = openStores(runtime, keys, { deliveredMaxEntries });
    const flow = new ReefMessageFlow({
      config: config(),
      trust: trust(
        Object.fromEntries(identities.map(({ peer, identity }) => [peer, peerTrust(identity)])),
      ).store,
      keys,
      transport: relay as unknown as ReefTransportClient, // SAFETY: ack-recording mock satisfies the client contract
      guard: guard(allow),
      audit: new MemoryAuditStore(new Uint8Array(32).fill(30)),
      replay,
      reviews,
      delivered,
      onIngress,
      onOwnerNotice: async () => {},
    });
    return new ReefInboxConnection(
      createClient(fetcher),
      async (batch) => {
        await flow.processEntries(batch);
      },
      () => {
        throw new Error("REST-only proof: no live socket expected");
      },
      { initialCursor: 0, persistCursor: (cursor) => persisted.push(cursor) },
    );
  }
  return { stores, raw, relay, onIngress, persisted, entries, connect };
}

describe("Reef capacity-parked delivery recovery (production connection path)", () => {
  beforeEach(resetFlowStoresForTests);
  afterEach(resetFlowStoresForTests);

  it("survives delivered-capacity parks from two peers, keeps later entries attemptable, and completes both once capacity frees", async () => {
    const { stores, raw, relay, onIngress, persisted, entries, connect } = await fixture(
      ["alice", "carol"],
      2,
    );
    await stores.delivered.confirm("occupied-1");
    await stores.delivered.confirm("occupied-2");
    const inbox = connect();

    // Both entries reach ingress, but capacity blocks confirmation and cursor progress.
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(2);
    expect(relay.acknowledge).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);

    raw.delete("occupied-1");
    raw.delete("occupied-2");
    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(4);
    expect(relay.acknowledge).toHaveBeenCalledTimes(2);
    for (const entry of entries) {
      await expect(stores.delivered.status(entry.id)).resolves.toBe("delivered");
    }
    expect(persisted.at(-1)).toBe(2);

    await inbox.drain();
    expect(onIngress).toHaveBeenCalledTimes(4);
    expect(relay.acknowledge).toHaveBeenCalledTimes(2);
  });

  it("a crash after ingress re-dispatches once on restart when capacity had blocked confirm", async () => {
    const { stores, raw, relay, onIngress, persisted, entries, connect } = await fixture(
      ["alice"],
      1,
    );
    await stores.delivered.confirm("occupied");
    await connect().drain();
    expect(onIngress).toHaveBeenCalledTimes(1);
    expect(relay.acknowledge).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);

    // The persisted replay survives a restart; absent confirmation allows one redispatch.
    raw.delete("occupied");
    await connect(reopenRuntime(stores.stateDir)).drain();
    expect(onIngress).toHaveBeenCalledTimes(2);
    await expect(stores.delivered.status(entries[0]!.id)).resolves.toBe("delivered");
    expect(relay.acknowledge).toHaveBeenCalledTimes(1);
    expect(persisted.at(-1)).toBe(1);
  });

  it("legacy stateless delivered markers suppress re-ingress and acknowledge on the next poll", async () => {
    const { stores, raw, relay, onIngress, persisted, entries, connect } = await fixture();
    const id = entries[0]!.id;
    raw.registerIfAbsent(id, { id });
    await connect().drain();
    expect(onIngress).not.toHaveBeenCalled();
    expect(relay.acknowledge).toHaveBeenCalledTimes(1);
    await expect(stores.delivered.status(id)).resolves.toBe("delivered");
    expect(persisted.at(-1)).toBe(1);
  });
});
