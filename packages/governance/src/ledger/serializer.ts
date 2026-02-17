/**
 * Event serialization and hashing.
 *
 * Borsh serialize → SHA-256 hash. Deterministic pipeline:
 * same event data → same borsh bytes → same hash. Always.
 */

import { sha256 } from "@noble/hashes/sha256";
import { serialize, deserialize } from "borsh";
import type { LedgerEventRecord, ContentEnvelope, MerkleBatchRecord } from "./schemas.js";
import {
  LedgerEventRecordSchema,
  ContentEnvelopeSchema,
  MerkleBatchRecordSchema,
} from "./schemas.js";

// ── Serialize / Deserialize ──────────────────────────────────────────────────

/** Serialize a LedgerEventRecord to deterministic borsh bytes. */
export function serializeEvent(event: LedgerEventRecord): Uint8Array {
  return serialize(LedgerEventRecordSchema, event);
}

/** Deserialize borsh bytes back to a LedgerEventRecord. */
export function deserializeEvent(bytes: Uint8Array): LedgerEventRecord {
  const raw = deserialize(LedgerEventRecordSchema, bytes) as Record<string, unknown>;
  return {
    seq: raw.seq as bigint,
    timestamp: raw.timestamp as bigint,
    actorDid: raw.actorDid as string,
    actorType: raw.actorType as number,
    action: raw.action as string,
    scopeType: raw.scopeType as number,
    scopeId: raw.scopeId as string,
    contentHash: new Uint8Array(raw.contentHash as ArrayBuffer),
    prevHash: new Uint8Array(raw.prevHash as ArrayBuffer),
  };
}

/** Serialize a ContentEnvelope to deterministic borsh bytes. */
export function serializeContent(envelope: ContentEnvelope): Uint8Array {
  return serialize(ContentEnvelopeSchema, envelope);
}

/** Deserialize borsh bytes back to a ContentEnvelope. */
export function deserializeContent(bytes: Uint8Array): ContentEnvelope {
  const raw = deserialize(ContentEnvelopeSchema, bytes) as Record<string, unknown>;
  return {
    contentType: raw.contentType as string,
    body: new Uint8Array(raw.body as ArrayBuffer),
  };
}

/** Serialize a MerkleBatchRecord to deterministic borsh bytes. */
export function serializeBatch(batch: MerkleBatchRecord): Uint8Array {
  return serialize(MerkleBatchRecordSchema, batch);
}

/** Deserialize borsh bytes back to a MerkleBatchRecord. */
export function deserializeBatch(bytes: Uint8Array): MerkleBatchRecord {
  const raw = deserialize(MerkleBatchRecordSchema, bytes) as Record<string, unknown>;
  return {
    merkleRoot: new Uint8Array(raw.merkleRoot as ArrayBuffer),
    eventCount: raw.eventCount as number,
    seqStart: raw.seqStart as bigint,
    seqEnd: raw.seqEnd as bigint,
    flushedAt: raw.flushedAt as bigint,
  };
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/** SHA-256 hash of arbitrary bytes. Returns 32-byte Uint8Array. */
export function hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/** Serialize a LedgerEventRecord to borsh, then SHA-256 hash it. */
export function hashEvent(event: LedgerEventRecord): Uint8Array {
  return hash(serializeEvent(event));
}

/** Serialize a ContentEnvelope to borsh, then SHA-256 hash it. */
export function hashContent(envelope: ContentEnvelope): Uint8Array {
  return hash(serializeContent(envelope));
}

/**
 * Compute the hash that links events in the chain.
 *
 * For the genesis event (seq 0), prevHash is all zeros.
 * For subsequent events, prevHash is the hash of the previous event's borsh bytes.
 */
export const GENESIS_HASH = new Uint8Array(32); // all zeros
