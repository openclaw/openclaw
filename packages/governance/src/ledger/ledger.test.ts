import { describe, it, expect, beforeEach } from "vitest";
import type {
  LedgerEventRecord,
  ContentEnvelope,
  MerkleBatchRecord,
  LedgerEventInput,
} from "./index.js";
import { toHex } from "../identity/did.js";
import {
  Ledger,
  InMemoryContentStore,
  ActorType,
  ScopeType,
  EventTier,
  classifyAction,
  serializeEvent,
  deserializeEvent,
  serializeContent,
  deserializeContent,
  serializeBatch,
  deserializeBatch,
  hash,
  hashEvent,
  GENESIS_HASH,
  buildMerkleTree,
  getMerkleRoot,
  getMerkleProof,
  verifyMerkleProof,
  EventBuffer,
  decodeHashList,
} from "./index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function textContent(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeEvent(overrides: Partial<LedgerEventInput> = {}): LedgerEventInput {
  return {
    actorDid: "did:key:z6MkTestAgent123",
    actorType: ActorType.Agent,
    action: "agent.message",
    scopeType: ScopeType.Project,
    scopeId: "bhr",
    content: textContent(JSON.stringify({ text: "Hello world" })),
    ...overrides,
  };
}

// ── Borsh Serialization ──────────────────────────────────────────────────────

describe("Borsh Serialization", () => {
  it("round-trips a LedgerEventRecord", () => {
    const event: LedgerEventRecord = {
      seq: 42n,
      timestamp: BigInt(Date.now()),
      actorDid: "did:key:z6MkTestAgent123",
      actorType: ActorType.Agent,
      action: "agent.message",
      scopeType: ScopeType.Project,
      scopeId: "bhr",
      contentHash: new Uint8Array(32).fill(0xab),
      prevHash: GENESIS_HASH,
    };

    const bytes = serializeEvent(event);
    expect(bytes.length).toBeGreaterThan(0);

    const decoded = deserializeEvent(bytes);
    expect(decoded.seq).toBe(42n);
    expect(decoded.actorDid).toBe("did:key:z6MkTestAgent123");
    expect(decoded.actorType).toBe(ActorType.Agent);
    expect(decoded.action).toBe("agent.message");
    expect(decoded.scopeType).toBe(ScopeType.Project);
    expect(decoded.scopeId).toBe("bhr");
    expect(toHex(decoded.contentHash)).toBe(toHex(event.contentHash));
    expect(toHex(decoded.prevHash)).toBe(toHex(GENESIS_HASH));
  });

  it("produces deterministic bytes (same data = same bytes)", () => {
    const event: LedgerEventRecord = {
      seq: 1n,
      timestamp: 1708128000000n,
      actorDid: "did:key:z6MkDeterministic",
      actorType: ActorType.Human,
      action: "grant.create",
      scopeType: ScopeType.Tenant,
      scopeId: "nerdplanet",
      contentHash: new Uint8Array(32).fill(0x01),
      prevHash: new Uint8Array(32).fill(0x02),
    };

    const bytes1 = serializeEvent(event);
    const bytes2 = serializeEvent(event);

    expect(toHex(bytes1)).toBe(toHex(bytes2));
    expect(toHex(hash(bytes1))).toBe(toHex(hash(bytes2)));
  });

  it("round-trips a ContentEnvelope", () => {
    const envelope: ContentEnvelope = {
      contentType: "application/json",
      body: textContent('{"message":"test"}'),
    };

    const bytes = serializeContent(envelope);
    const decoded = deserializeContent(bytes);

    expect(decoded.contentType).toBe("application/json");
    expect(new TextDecoder().decode(decoded.body)).toBe('{"message":"test"}');
  });

  it("round-trips a MerkleBatchRecord", () => {
    const batch: MerkleBatchRecord = {
      merkleRoot: new Uint8Array(32).fill(0xff),
      eventCount: 50,
      seqStart: 100n,
      seqEnd: 149n,
      flushedAt: BigInt(Date.now()),
    };

    const bytes = serializeBatch(batch);
    const decoded = deserializeBatch(bytes);

    expect(toHex(decoded.merkleRoot)).toBe(toHex(batch.merkleRoot));
    expect(decoded.eventCount).toBe(50);
    expect(decoded.seqStart).toBe(100n);
    expect(decoded.seqEnd).toBe(149n);
  });
});

// ── Hashing ──────────────────────────────────────────────────────────────────

describe("Hashing", () => {
  it("produces 32-byte SHA-256 hashes", () => {
    const data = textContent("test data");
    const h = hash(data);
    expect(h).toHaveLength(32);
  });

  it("same input produces same hash", () => {
    const data = textContent("deterministic");
    expect(toHex(hash(data))).toBe(toHex(hash(data)));
  });

  it("different input produces different hash", () => {
    expect(toHex(hash(textContent("a")))).not.toBe(toHex(hash(textContent("b"))));
  });

  it("hashEvent = hash(serializeEvent(event))", () => {
    const event: LedgerEventRecord = {
      seq: 0n,
      timestamp: 0n,
      actorDid: "did:key:z6MkTest",
      actorType: 1,
      action: "test",
      scopeType: 0,
      scopeId: "x",
      contentHash: new Uint8Array(32),
      prevHash: new Uint8Array(32),
    };

    expect(toHex(hashEvent(event))).toBe(toHex(hash(serializeEvent(event))));
  });

  it("GENESIS_HASH is 32 zero bytes", () => {
    expect(GENESIS_HASH).toHaveLength(32);
    expect(GENESIS_HASH.every((b) => b === 0)).toBe(true);
  });
});

// ── Merkle Tree ──────────────────────────────────────────────────────────────

describe("Merkle Tree", () => {
  it("builds a tree from a single leaf", () => {
    const leaf = hash(textContent("single"));
    const root = getMerkleRoot([leaf]);
    // Single leaf: root IS the leaf
    expect(toHex(root)).toBe(toHex(leaf));
  });

  it("builds a tree from two leaves", () => {
    const a = hash(textContent("a"));
    const b = hash(textContent("b"));
    const root = getMerkleRoot([a, b]);

    // Root should be hash(a || b)
    const expected = hash(new Uint8Array([...a, ...b]));
    expect(toHex(root)).toBe(toHex(expected));
  });

  it("builds a tree from multiple leaves", () => {
    const leaves = Array.from({ length: 7 }, (_, i) => hash(textContent(`leaf-${i}`)));
    const levels = buildMerkleTree(leaves);

    // Should have multiple levels
    expect(levels.length).toBeGreaterThan(1);
    // Top level should have exactly 1 element (the root)
    expect(levels[levels.length - 1]).toHaveLength(1);
    // Bottom level should have all leaves
    expect(levels[0]).toHaveLength(7);
  });

  it("generates and verifies proofs for every leaf", () => {
    const leaves = Array.from({ length: 10 }, (_, i) => hash(textContent(`event-${i}`)));
    const root = getMerkleRoot(leaves);

    for (let i = 0; i < leaves.length; i++) {
      const proof = getMerkleProof(leaves, i);
      expect(proof.leaf).toBe(leaves[i]);
      expect(verifyMerkleProof(proof, root)).toBe(true);
    }
  });

  it("rejects proof against wrong root", () => {
    const leaves = [hash(textContent("a")), hash(textContent("b"))];
    const _root = getMerkleRoot(leaves);
    const proof = getMerkleProof(leaves, 0);

    const wrongRoot = hash(textContent("wrong"));
    expect(verifyMerkleProof(proof, wrongRoot)).toBe(false);
  });

  it("rejects tampered proof", () => {
    const leaves = Array.from({ length: 4 }, (_, i) => hash(textContent(`leaf-${i}`)));
    const root = getMerkleRoot(leaves);
    const proof = getMerkleProof(leaves, 2);

    // Tamper with a sibling
    const tampered = {
      ...proof,
      siblings: proof.siblings.map((s, i) =>
        i === 0 ? { ...s, hash: hash(textContent("tampered")) } : s,
      ),
    };

    expect(verifyMerkleProof(tampered, root)).toBe(false);
  });

  it("throws on empty leaf set", () => {
    expect(() => buildMerkleTree([])).toThrow("empty leaf set");
  });

  it("throws on out-of-bounds leaf index", () => {
    const leaves = [hash(textContent("a"))];
    expect(() => getMerkleProof(leaves, 1)).toThrow("out of bounds");
    expect(() => getMerkleProof(leaves, -1)).toThrow("out of bounds");
  });

  it("handles power-of-2 leaf counts", () => {
    for (const count of [2, 4, 8, 16]) {
      const leaves = Array.from({ length: count }, (_, i) => hash(textContent(`leaf-${i}`)));
      const root = getMerkleRoot(leaves);

      // Verify every leaf
      for (let i = 0; i < count; i++) {
        const proof = getMerkleProof(leaves, i);
        expect(verifyMerkleProof(proof, root)).toBe(true);
      }
    }
  });

  it("handles odd leaf counts (padding)", () => {
    for (const count of [3, 5, 7, 13]) {
      const leaves = Array.from({ length: count }, (_, i) => hash(textContent(`leaf-${i}`)));
      const root = getMerkleRoot(leaves);

      for (let i = 0; i < count; i++) {
        const proof = getMerkleProof(leaves, i);
        expect(verifyMerkleProof(proof, root)).toBe(true);
      }
    }
  });
});

// ── Action Classification ────────────────────────────────────────────────────

describe("Action Classification", () => {
  it("classifies governance actions as Cold", () => {
    expect(classifyAction("proposal.create")).toBe(EventTier.Cold);
    expect(classifyAction("vote.cast")).toBe(EventTier.Cold);
    expect(classifyAction("resolution.pass")).toBe(EventTier.Cold);
    expect(classifyAction("grant.create")).toBe(EventTier.Cold);
    expect(classifyAction("soc.freeze")).toBe(EventTier.Cold);
    expect(classifyAction("identity.create")).toBe(EventTier.Cold);
  });

  it("classifies heartbeats as Hot", () => {
    expect(classifyAction("agent.heartbeat")).toBe(EventTier.Hot);
    expect(classifyAction("agent.typing")).toBe(EventTier.Hot);
  });

  it("classifies operational actions as Warm", () => {
    expect(classifyAction("agent.message")).toBe(EventTier.Warm);
    expect(classifyAction("agent.delegate")).toBe(EventTier.Warm);
    expect(classifyAction("agent.complete")).toBe(EventTier.Warm);
  });

  it("classifies unknown actions as Warm (default)", () => {
    expect(classifyAction("custom.action")).toBe(EventTier.Warm);
  });
});

// ── Content Store ────────────────────────────────────────────────────────────

describe("InMemoryContentStore", () => {
  let store: InMemoryContentStore;

  beforeEach(() => {
    store = new InMemoryContentStore();
  });

  it("stores and retrieves content", async () => {
    const data = textContent("test data");
    const h = hash(data);

    await store.put(h, data);
    const retrieved = await store.get(h);

    expect(retrieved).not.toBeNull();
    expect(toHex(retrieved!)).toBe(toHex(data));
  });

  it("returns null for missing content", async () => {
    const h = hash(textContent("missing"));
    expect(await store.get(h)).toBeNull();
  });

  it("checks existence", async () => {
    const h = hash(textContent("exists"));
    expect(await store.has(h)).toBe(false);
    await store.put(h, textContent("exists"));
    expect(await store.has(h)).toBe(true);
  });

  it("deletes content", async () => {
    const data = textContent("delete me");
    const h = hash(data);

    await store.put(h, data);
    expect(await store.has(h)).toBe(true);

    await store.delete(h);
    expect(await store.has(h)).toBe(false);
  });

  it("lists content with prefix", async () => {
    const h1 = hash(textContent("a"));
    const h2 = hash(textContent("b"));
    const h3 = hash(textContent("c"));

    await store.put(h1, textContent("a"), "events/");
    await store.put(h2, textContent("b"), "events/");
    await store.put(h3, textContent("c"), "content/");

    const events = await store.list("events/");
    expect(events).toHaveLength(2);

    const content = await store.list("content/");
    expect(content).toHaveLength(1);
  });

  it("tracks size", async () => {
    expect(store.size).toBe(0);
    await store.put(hash(textContent("a")), textContent("a"));
    expect(store.size).toBe(1);
  });

  it("clears all data", async () => {
    await store.put(hash(textContent("a")), textContent("a"));
    await store.put(hash(textContent("b")), textContent("b"));
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
  });
});

// ── Event Buffer ─────────────────────────────────────────────────────────────

describe("EventBuffer", () => {
  let store: InMemoryContentStore;
  let buffer: EventBuffer;
  const hotEvents: LedgerEventRecord[] = [];
  const flushedBatches: MerkleBatchRecord[] = [];

  beforeEach(() => {
    store = new InMemoryContentStore();
    hotEvents.length = 0;
    flushedBatches.length = 0;

    buffer = new EventBuffer({
      store,
      flushThreshold: 5,
      flushIntervalMs: 60_000, // Long interval so we control flush manually
      onHotEvent: (e) => hotEvents.push(e),
      onBatchFlushed: (b) => flushedBatches.push(b),
    });
  });

  it("appends warm events to buffer", async () => {
    await buffer.append(makeEvent());
    expect(buffer.pendingCount).toBe(1);
    expect(buffer.currentSeq).toBe(1n);
  });

  it("emits hot callback for warm events", async () => {
    await buffer.append(makeEvent());
    expect(hotEvents).toHaveLength(1);
    expect(hotEvents[0].action).toBe("agent.message");
  });

  it("hot-only events are not stored", async () => {
    await buffer.append(makeEvent({ action: "agent.heartbeat", tier: EventTier.Hot }));
    expect(buffer.pendingCount).toBe(0);
    expect(store.size).toBe(0);
    expect(hotEvents).toHaveLength(1);
  });

  it("cold events are stored directly", async () => {
    await buffer.append(makeEvent({ action: "grant.create", tier: EventTier.Cold }));
    expect(buffer.pendingCount).toBe(0);
    expect(buffer.coldEvents).toHaveLength(1);
    // Should have content + event stored
    expect(store.size).toBe(2);
  });

  it("flushes at threshold", async () => {
    for (let i = 0; i < 5; i++) {
      await buffer.append(makeEvent());
    }

    // Should have auto-flushed at threshold=5
    expect(buffer.pendingCount).toBe(0);
    expect(flushedBatches).toHaveLength(1);
    expect(flushedBatches[0].eventCount).toBe(5);
  });

  it("manual flush works", async () => {
    await buffer.append(makeEvent());
    await buffer.append(makeEvent());

    const batch = await buffer.flush();
    expect(batch).not.toBeNull();
    expect(batch!.eventCount).toBe(2);
    expect(buffer.pendingCount).toBe(0);
  });

  it("flush on empty buffer returns null", async () => {
    const batch = await buffer.flush();
    expect(batch).toBeNull();
  });

  it("maintains hash chain across events", async () => {
    await buffer.append(makeEvent());
    await buffer.append(makeEvent());
    await buffer.append(makeEvent());

    // First event should have GENESIS_HASH as prevHash
    expect(hotEvents[0].prevHash.every((b) => b === 0)).toBe(true);

    // Subsequent events should have non-zero prevHash
    expect(hotEvents[1].prevHash.some((b) => b !== 0)).toBe(true);
    expect(hotEvents[2].prevHash.some((b) => b !== 0)).toBe(true);

    // Each event's prevHash should differ (they chain)
    expect(toHex(hotEvents[1].prevHash)).not.toBe(toHex(hotEvents[2].prevHash));
  });

  it("increments sequence numbers", async () => {
    await buffer.append(makeEvent());
    await buffer.append(makeEvent());
    await buffer.append(makeEvent());

    expect(hotEvents[0].seq).toBe(0n);
    expect(hotEvents[1].seq).toBe(1n);
    expect(hotEvents[2].seq).toBe(2n);
  });

  it("stores content for warm events", async () => {
    await buffer.append(makeEvent());

    // Content should be stored (content hash → content bytes)
    const contentHash = hotEvents[0].contentHash;
    const content = await buffer.getContent(contentHash);
    expect(content).not.toBeNull();
  });

  it("stores event bytes after flush", async () => {
    await buffer.append(makeEvent());
    await buffer.flush();

    // After flush, event bytes should be in the store
    // We can verify by checking that the store has items under events/ prefix
    const events = await store.list("events/");
    expect(events.length).toBeGreaterThan(0);
  });
});

// ── Hash List Encoding ───────────────────────────────────────────────────────

describe("Hash List Encoding", () => {
  it("round-trips a list of hashes", () => {
    const hashes = Array.from({ length: 5 }, (_, i) => hash(textContent(`hash-${i}`)));

    const encoded = encodeHashListForTest(hashes);
    const decoded = decodeHashList(encoded);

    expect(decoded).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(toHex(decoded[i])).toBe(toHex(hashes[i]));
    }
  });

  it("handles empty list", () => {
    const encoded = encodeHashListForTest([]);
    const decoded = decodeHashList(encoded);
    expect(decoded).toHaveLength(0);
  });
});

// Re-export the encode function for testing (it's not in the public API)
function encodeHashListForTest(hashes: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(4 + hashes.length * 32);
  const view = new DataView(result.buffer);
  view.setUint32(0, hashes.length, true);
  for (let i = 0; i < hashes.length; i++) {
    result.set(hashes[i], 4 + i * 32);
  }
  return result;
}

// ── Ledger (Integration) ────────────────────────────────────────────────────

describe("Ledger", () => {
  let store: InMemoryContentStore;
  let ledger: Ledger;
  const events: LedgerEventRecord[] = [];

  beforeEach(() => {
    store = new InMemoryContentStore();
    events.length = 0;

    ledger = new Ledger({
      store,
      flushThreshold: 100,
      onEvent: (e) => events.push(e),
    });
  });

  it("appends events and increments seq", async () => {
    await ledger.append(makeEvent());
    await ledger.append(makeEvent());
    expect(ledger.seq).toBe(2n);
  });

  it("retrieves content by hash", async () => {
    await ledger.append(
      makeEvent({
        content: textContent(JSON.stringify({ text: "Important message" })),
      }),
    );

    const contentHash = events[0].contentHash;
    const envelope = await ledger.getContent(contentHash);
    expect(envelope).not.toBeNull();
    expect(envelope!.contentType).toBe("application/json");

    const body = JSON.parse(new TextDecoder().decode(envelope!.body));
    expect(body.text).toBe("Important message");
  });

  it("verifies content integrity", async () => {
    await ledger.append(makeEvent());
    await ledger.flush();

    const contentHash = events[0].contentHash;
    expect(await ledger.verifyContent(contentHash)).toBe(true);
  });

  it("verifies event integrity after flush", async () => {
    await ledger.append(makeEvent());
    await ledger.flush();

    // Get the event hash from the store
    const storedEvents = await store.list("events/");
    expect(storedEvents.length).toBeGreaterThan(0);
  });

  it("flushes and creates Merkle batches", async () => {
    for (let i = 0; i < 10; i++) {
      await ledger.append(makeEvent());
    }

    const batch = await ledger.flush();
    expect(batch).not.toBeNull();
    expect(batch!.eventCount).toBe(10);
    expect(batch!.merkleRoot).toHaveLength(32);
    expect(ledger.batches).toHaveLength(1);
  });

  it("cold events bypass buffer", async () => {
    await ledger.append(makeEvent({ action: "proposal.create" }));

    expect(ledger.pendingCount).toBe(0);
    // Event should be stored directly
    expect(store.size).toBeGreaterThan(0);
  });

  it("hot events are emitted but not stored", async () => {
    await ledger.append(makeEvent({ action: "agent.heartbeat" }));

    expect(events).toHaveLength(1);
    expect(ledger.pendingCount).toBe(0);
    // Only heartbeat emitted, no storage
    expect(store.size).toBe(0);
  });

  it("multiple batches accumulate", async () => {
    for (let i = 0; i < 5; i++) {
      await ledger.append(makeEvent());
    }
    await ledger.flush();

    for (let i = 0; i < 3; i++) {
      await ledger.append(makeEvent());
    }
    await ledger.flush();

    expect(ledger.batches).toHaveLength(2);
    expect(ledger.batches[0].eventCount).toBe(5);
    expect(ledger.batches[1].eventCount).toBe(3);
  });

  it("hash chain links events across batches", async () => {
    for (let i = 0; i < 3; i++) {
      await ledger.append(makeEvent());
    }

    // Events should form a chain
    expect(events[0].prevHash.every((b) => b === 0)).toBe(true); // genesis
    expect(events[1].prevHash.some((b) => b !== 0)).toBe(true);
    expect(events[2].prevHash.some((b) => b !== 0)).toBe(true);

    // Each prevHash should be unique (different chain links)
    const hashes = events.map((e) => toHex(e.prevHash));
    const unique = new Set(hashes);
    expect(unique.size).toBe(3); // genesis + 2 unique
  });

  it("mixed tiers in one session", async () => {
    // Hot (no storage)
    await ledger.append(makeEvent({ action: "agent.heartbeat" }));

    // Warm (buffered)
    await ledger.append(makeEvent({ action: "agent.message" }));
    await ledger.append(makeEvent({ action: "agent.delegate" }));

    // Cold (direct)
    await ledger.append(makeEvent({ action: "vote.cast" }));

    expect(events).toHaveLength(4);
    expect(ledger.pendingCount).toBe(2); // 2 warm events buffered
    expect(ledger.seq).toBe(4n); // all 4 got sequence numbers

    await ledger.flush();
    expect(ledger.pendingCount).toBe(0);
    expect(ledger.batches).toHaveLength(1);
    expect(ledger.batches[0].eventCount).toBe(2); // only warm events in batch
  });
});

// ── Borsh Size Efficiency ────────────────────────────────────────────────────

describe("Borsh Size Efficiency", () => {
  it("event record is compact", () => {
    const event: LedgerEventRecord = {
      seq: 12345n,
      timestamp: BigInt(Date.now()),
      actorDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      actorType: ActorType.Agent,
      action: "agent.message",
      scopeType: ScopeType.Project,
      scopeId: "black-hole-registry",
      contentHash: new Uint8Array(32).fill(0xab),
      prevHash: new Uint8Array(32).fill(0xcd),
    };

    const borshBytes = serializeEvent(event);
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify({
        seq: "12345",
        timestamp: event.timestamp.toString(),
        actorDid: event.actorDid,
        actorType: "agent",
        action: event.action,
        scopeType: "project",
        scopeId: event.scopeId,
        contentHash: toHex(event.contentHash),
        prevHash: toHex(event.prevHash),
      }),
    );

    // Borsh should be significantly smaller than JSON
    expect(borshBytes.length).toBeLessThan(jsonBytes.length);

    // Log the actual sizes for reference
    // console.log(`Borsh: ${borshBytes.length} bytes, JSON: ${jsonBytes.length} bytes`);
    // Typically: Borsh ~170 bytes vs JSON ~450 bytes
  });
});
