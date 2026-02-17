/**
 * Event buffer with Merkle batch flushing.
 *
 * Hot path:  Events emitted via callback (WebSocket → dashboard). No storage.
 * Warm path: Events accumulated in buffer, flushed as Merkle batches.
 * Cold path: Events written directly to content store. No buffering.
 *
 * Flush triggers:
 * - Timer (e.g., every 30 seconds)
 * - Event count threshold (e.g., every 100 events)
 * - Manual flush (for graceful shutdown)
 */

import type {
  LedgerEventRecord,
  ContentEnvelope,
  MerkleBatchRecord,
  LedgerEventInput,
} from "./schemas.js";
import type { ContentStore } from "./store.js";
import { getMerkleRoot } from "./merkle.js";
import { EventTier, classifyAction } from "./schemas.js";
import {
  serializeEvent,
  serializeContent,
  serializeBatch,
  hashContent,
  hash,
  GENESIS_HASH,
} from "./serializer.js";

// ── Configuration ────────────────────────────────────────────────────────────

export interface EventBufferConfig {
  /** Content store for warm + cold path persistence. */
  store: ContentStore;
  /** Flush interval in milliseconds. Default: 30000 (30s). */
  flushIntervalMs?: number;
  /** Flush when buffer reaches this many events. Default: 100. */
  flushThreshold?: number;
  /** Callback for hot-path events (e.g., WebSocket to dashboard). */
  onHotEvent?: (event: LedgerEventRecord) => void;
  /** Callback when a Merkle batch is flushed. */
  onBatchFlushed?: (batch: MerkleBatchRecord) => void;
  /** Enable/disable chain features. Default: false (off-chain only). */
  onChain?: boolean;
}

// ── Event Buffer ─────────────────────────────────────────────────────────────

export class EventBuffer {
  private store: ContentStore;
  private buffer: Array<{
    event: LedgerEventRecord;
    eventBytes: Uint8Array;
    eventHash: Uint8Array;
  }> = [];
  private seq = 0n;
  private prevHash: Uint8Array = GENESIS_HASH;
  private flushIntervalMs: number;
  private flushThreshold: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private onHotEvent?: (event: LedgerEventRecord) => void;
  private onBatchFlushed?: (batch: MerkleBatchRecord) => void;
  private flushing = false;

  /** All Merkle batch records flushed so far (in memory, for queries). */
  readonly batches: MerkleBatchRecord[] = [];

  /** All cold-path event hashes (direct writes). */
  readonly coldEvents: Array<{
    event: LedgerEventRecord;
    eventHash: Uint8Array;
  }> = [];

  constructor(config: EventBufferConfig) {
    this.store = config.store;
    this.flushIntervalMs = config.flushIntervalMs ?? 30_000;
    this.flushThreshold = config.flushThreshold ?? 100;
    this.onHotEvent = config.onHotEvent;
    this.onBatchFlushed = config.onBatchFlushed;
  }

  /** Start the periodic flush timer. */
  start(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  /** Stop the flush timer and flush remaining events. */
  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  /** Current sequence number (next event will be this + 1). */
  get currentSeq(): bigint {
    return this.seq;
  }

  /** Number of events waiting in the warm buffer. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /**
   * Append an event to the ledger.
   *
   * Routing:
   * - Hot:  Emitted via callback only. No storage.
   * - Warm: Buffered for Merkle batching.
   * - Cold: Written directly to content store.
   *
   * All paths maintain the hash chain (prevHash linking).
   */
  async append(input: LedgerEventInput): Promise<LedgerEventRecord> {
    const tier = input.tier ?? classifyAction(input.action);

    // Wrap content in envelope and hash it
    const envelope: ContentEnvelope = {
      contentType: input.contentType ?? "application/json",
      body: input.content,
    };
    const contentBytes = serializeContent(envelope);
    const contentHashBytes = hashContent(envelope);

    // Build the event record
    const event: LedgerEventRecord = {
      seq: this.seq,
      timestamp: BigInt(Date.now()),
      actorDid: input.actorDid,
      actorType: input.actorType,
      action: input.action,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      contentHash: contentHashBytes,
      prevHash: this.prevHash,
    };

    // Serialize and hash the event
    const eventBytes = serializeEvent(event);
    const eventHash = hash(eventBytes);

    // Update chain state
    this.prevHash = eventHash;
    this.seq++;

    // Route by tier
    if (tier === EventTier.Hot) {
      // Hot: callback only, no storage
      this.onHotEvent?.(event);
    } else if (tier === EventTier.Warm) {
      // Warm: buffer for Merkle batching
      this.buffer.push({ event, eventBytes, eventHash });

      // Also emit to hot callback (warm events are also visible on dashboard)
      this.onHotEvent?.(event);

      // Store content
      await this.store.put(contentHashBytes, contentBytes, "content/");

      // Check flush threshold
      if (this.buffer.length >= this.flushThreshold) {
        await this.flush();
      }
    } else {
      // Cold: direct write, full persistence
      await this.store.put(contentHashBytes, contentBytes, "content/");
      await this.store.put(eventHash, eventBytes, "events/");

      this.coldEvents.push({ event, eventHash });

      // Also emit to hot callback
      this.onHotEvent?.(event);
    }

    return event;
  }

  /**
   * Flush the warm buffer: compute Merkle root, store batch + events.
   *
   * Called automatically by timer or threshold, or manually for shutdown.
   */
  async flush(): Promise<MerkleBatchRecord | null> {
    if (this.buffer.length === 0 || this.flushing) {
      return null;
    }

    this.flushing = true;

    try {
      const batch = [...this.buffer];
      this.buffer = [];

      // Store each event's serialized bytes
      const eventHashes: Uint8Array[] = [];
      for (const entry of batch) {
        await this.store.put(entry.eventHash, entry.eventBytes, "events/");
        eventHashes.push(entry.eventHash);
      }

      // Compute Merkle root
      const merkleRoot = getMerkleRoot(eventHashes);

      // Build batch record
      const batchRecord: MerkleBatchRecord = {
        merkleRoot,
        eventCount: batch.length,
        seqStart: batch[0].event.seq,
        seqEnd: batch[batch.length - 1].event.seq,
        flushedAt: BigInt(Date.now()),
      };

      // Store batch metadata
      const batchBytes = serializeBatch(batchRecord);
      const batchHash = hash(batchBytes);
      await this.store.put(batchHash, batchBytes, "batches/");

      // Store the event hash list for proof generation
      const hashListBytes = encodeHashList(eventHashes);
      await this.store.put(merkleRoot, hashListBytes, "batch-leaves/");

      this.batches.push(batchRecord);
      this.onBatchFlushed?.(batchRecord);

      return batchRecord;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Get a specific event by its hash from the content store.
   */
  async getEvent(eventHash: Uint8Array): Promise<Uint8Array | null> {
    return this.store.get(eventHash, "events/");
  }

  /**
   * Get content by its hash from the content store.
   */
  async getContent(contentHash: Uint8Array): Promise<Uint8Array | null> {
    return this.store.get(contentHash, "content/");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Encode a list of 32-byte hashes as a single byte array (length-prefixed). */
function encodeHashList(hashes: Uint8Array[]): Uint8Array {
  // 4-byte little-endian count + N × 32-byte hashes
  const result = new Uint8Array(4 + hashes.length * 32);
  const view = new DataView(result.buffer);
  view.setUint32(0, hashes.length, true);
  for (let i = 0; i < hashes.length; i++) {
    result.set(hashes[i], 4 + i * 32);
  }
  return result;
}

/** Decode a hash list back to an array of 32-byte hashes. */
export function decodeHashList(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const hashes: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    hashes.push(bytes.slice(4 + i * 32, 4 + (i + 1) * 32));
  }
  return hashes;
}
