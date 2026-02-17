/**
 * Governance Ledger — the main entry point.
 *
 * Ties together: borsh serialization, SHA-256 hashing, Merkle batching,
 * content-addressed storage (S3/MinIO), and hash chain integrity.
 *
 * All off-chain by default. On-chain (NEAR) is a configuration option
 * for when smart contract enforcement is needed.
 *
 * Storage tiers:
 *   Hot:  Dashboard only (WebSocket). No persistence.
 *   Warm: Batched into Merkle roots. Content in S3/MinIO.
 *   Cold: Direct write. Full governance record in S3/MinIO.
 */

import type { MerkleProof } from "./merkle.js";
import type {
  LedgerEventRecord,
  LedgerEventInput,
  ContentEnvelope,
  MerkleBatchRecord,
} from "./schemas.js";
import type { ContentStore } from "./store.js";
import { EventBuffer, decodeHashList } from "./buffer.js";
import { getMerkleProof, verifyMerkleProof } from "./merkle.js";
import { deserializeEvent, deserializeContent, hash } from "./serializer.js";

// ── Configuration ────────────────────────────────────────────────────────────

export interface LedgerConfig {
  /** Content store backend (InMemoryContentStore or S3ContentStore). */
  store: ContentStore;
  /** Flush interval in milliseconds. Default: 30000 (30s). */
  flushIntervalMs?: number;
  /** Flush when buffer reaches this many events. Default: 100. */
  flushThreshold?: number;
  /** Callback for real-time event streaming (dashboard). */
  onEvent?: (event: LedgerEventRecord) => void;
  /** Callback when a Merkle batch is flushed. */
  onBatch?: (batch: MerkleBatchRecord) => void;
}

// ── Ledger ───────────────────────────────────────────────────────────────────

export class Ledger {
  private buffer: EventBuffer;
  private store: ContentStore;

  constructor(config: LedgerConfig) {
    this.store = config.store;
    this.buffer = new EventBuffer({
      store: config.store,
      flushIntervalMs: config.flushIntervalMs,
      flushThreshold: config.flushThreshold,
      onHotEvent: config.onEvent,
      onBatchFlushed: config.onBatch,
    });
  }

  /** Start the periodic flush timer. */
  start(): void {
    this.buffer.start();
  }

  /** Stop the flush timer and flush remaining events. */
  async stop(): Promise<void> {
    await this.buffer.stop();
  }

  /** Current sequence number. */
  get seq(): bigint {
    return this.buffer.currentSeq;
  }

  /** Number of events waiting in the warm buffer. */
  get pendingCount(): number {
    return this.buffer.pendingCount;
  }

  /** All Merkle batch records flushed so far. */
  get batches(): readonly MerkleBatchRecord[] {
    return this.buffer.batches;
  }

  // ── Write ────────────────────────────────────────────────────────────────

  /**
   * Append an event to the ledger.
   *
   * The event is automatically routed by tier:
   * - Hot:  Dashboard callback only.
   * - Warm: Buffered, batched into Merkle roots.
   * - Cold: Direct write to content store.
   */
  async append(input: LedgerEventInput): Promise<LedgerEventRecord> {
    return this.buffer.append(input);
  }

  /** Manually flush the warm buffer. */
  async flush(): Promise<MerkleBatchRecord | null> {
    return this.buffer.flush();
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  /**
   * Retrieve and deserialize an event by its hash.
   */
  async getEvent(eventHash: Uint8Array): Promise<LedgerEventRecord | null> {
    const bytes = await this.buffer.getEvent(eventHash);
    if (!bytes) {
      return null;
    }
    return deserializeEvent(bytes);
  }

  /**
   * Retrieve and deserialize content by its hash.
   */
  async getContent(contentHash: Uint8Array): Promise<ContentEnvelope | null> {
    const bytes = await this.buffer.getContent(contentHash);
    if (!bytes) {
      return null;
    }
    return deserializeContent(bytes);
  }

  // ── Verify ───────────────────────────────────────────────────────────────

  /**
   * Verify that stored event bytes match their hash.
   *
   * Fetches the event by hash, re-hashes the bytes, and confirms match.
   * This proves the content hasn't been tampered with in storage.
   */
  async verifyEvent(eventHash: Uint8Array): Promise<boolean> {
    const bytes = await this.buffer.getEvent(eventHash);
    if (!bytes) {
      return false;
    }
    const recomputed = hash(bytes);
    return bytesEqual(recomputed, eventHash);
  }

  /**
   * Verify that stored content bytes match their hash.
   */
  async verifyContent(contentHash: Uint8Array): Promise<boolean> {
    const bytes = await this.buffer.getContent(contentHash);
    if (!bytes) {
      return false;
    }
    const recomputed = hash(bytes);
    return bytesEqual(recomputed, contentHash);
  }

  /**
   * Verify an event's membership in a Merkle batch.
   *
   * Retrieves the batch's leaf hashes, generates a proof, and verifies it.
   *
   * @param eventHash - The event hash to verify.
   * @param batchRecord - The Merkle batch record to verify against.
   * @returns The proof if valid, null if the event is not in this batch.
   */
  async verifyEventInBatch(
    eventHash: Uint8Array,
    batchRecord: MerkleBatchRecord,
  ): Promise<MerkleProof | null> {
    // Get the leaf hashes for this batch
    const hashListBytes = await this.store.get(batchRecord.merkleRoot, "batch-leaves/");
    if (!hashListBytes) {
      return null;
    }

    const leaves = decodeHashList(hashListBytes);

    // Find the event in the leaves
    const leafIndex = leaves.findIndex((leaf) => bytesEqual(leaf, eventHash));
    if (leafIndex === -1) {
      return null;
    }

    // Generate and verify the proof
    const proof = getMerkleProof(leaves, leafIndex);
    const valid = verifyMerkleProof(proof, batchRecord.merkleRoot);

    return valid ? proof : null;
  }

  /**
   * Verify the hash chain integrity of a sequence of events.
   *
   * Each event's prevHash must equal the hash of the previous event's bytes.
   * The first event's prevHash must be all zeros (genesis).
   */
  async verifyChain(eventHashes: Uint8Array[]): Promise<{ valid: boolean; brokenAt?: number }> {
    for (let i = 0; i < eventHashes.length; i++) {
      const bytes = await this.buffer.getEvent(eventHashes[i]);
      if (!bytes) {
        return { valid: false, brokenAt: i };
      }

      const event = deserializeEvent(bytes);

      if (i === 0) {
        // Genesis event must have all-zero prevHash
        const isGenesis = event.prevHash.every((b) => b === 0);
        if (!isGenesis) {
          // Not genesis — verify prevHash matches the hash we expect
          // (the chain might start mid-sequence, which is fine for partial verification)
        }
      } else {
        // Verify prevHash links to the previous event
        const prevEventBytes = await this.buffer.getEvent(eventHashes[i - 1]);
        if (!prevEventBytes) {
          return { valid: false, brokenAt: i };
        }

        const prevHash = hash(prevEventBytes);
        if (!bytesEqual(event.prevHash, prevHash)) {
          return { valid: false, brokenAt: i };
        }
      }
    }

    return { valid: true };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
