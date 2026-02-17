/**
 * Borsh serialization schemas for the governance ledger.
 *
 * All ledger data is serialized with borsh (Binary Object Representation
 * Serializer for Hashing) to guarantee deterministic byte output.
 * Same data → same bytes → same hash. Always.
 *
 * @see https://borsh.io/
 */

import type { Schema } from "borsh";

// ── Actor & Scope Enums ──────────────────────────────────────────────────────

/** Actor type encoded as u8 for borsh serialization. */
export const ActorType = {
  Human: 0,
  Agent: 1,
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];

/** Scope type encoded as u8 for borsh serialization. */
export const ScopeType = {
  Tenant: 0,
  Project: 1,
  Agent: 2,
} as const;
export type ScopeType = (typeof ScopeType)[keyof typeof ScopeType];

/** Event tier determines storage routing. */
export const EventTier = {
  /** Real-time dashboard, no persistence (WebSocket only). */
  Hot: 0,
  /** Batched into Merkle roots, content stored in S3/MinIO. */
  Warm: 1,
  /** Direct write, full data persisted, governance significance. */
  Cold: 2,
} as const;
export type EventTier = (typeof EventTier)[keyof typeof EventTier];

// ── Ledger Event Record ──────────────────────────────────────────────────────

/**
 * Compact, hashable ledger event record.
 *
 * This is the canonical representation that gets borsh-serialized and hashed.
 * Full content (message text, task details, etc.) is stored separately in the
 * content store, referenced by contentHash.
 */
export interface LedgerEventRecord {
  /** Monotonic sequence number within this ledger. */
  seq: bigint;
  /** Unix timestamp in milliseconds. */
  timestamp: bigint;
  /** DID of the actor (human or agent). */
  actorDid: string;
  /** Actor type: 0 = Human, 1 = Agent. */
  actorType: number;
  /** Action identifier (e.g., "agent.message", "vote.cast"). */
  action: string;
  /** Scope type: 0 = Tenant, 1 = Project, 2 = Agent. */
  scopeType: number;
  /** Scope identifier (tenant ID, project ID, or agent ID). */
  scopeId: string;
  /** SHA-256 hash of the full content (stored in content store). */
  contentHash: Uint8Array;
  /** SHA-256 hash of the previous event's borsh bytes (hash chain). */
  prevHash: Uint8Array;
}

/** Borsh schema for LedgerEventRecord. */
export const LedgerEventRecordSchema: Schema = {
  struct: {
    seq: "u64",
    timestamp: "u64",
    actorDid: "string",
    actorType: "u8",
    action: "string",
    scopeType: "u8",
    scopeId: "string",
    contentHash: { array: { type: "u8", len: 32 } },
    prevHash: { array: { type: "u8", len: 32 } },
  },
};

// ── Content Envelope ─────────────────────────────────────────────────────────

/**
 * Full content envelope stored in the content store (S3/MinIO).
 *
 * The content hash of this envelope's borsh bytes is what appears in the
 * LedgerEventRecord.contentHash field.
 */
export interface ContentEnvelope {
  /** MIME-like content type (e.g., "text/plain", "application/json"). */
  contentType: string;
  /** The actual content bytes. */
  body: Uint8Array;
}

/** Borsh schema for ContentEnvelope. */
export const ContentEnvelopeSchema: Schema = {
  struct: {
    contentType: "string",
    body: { array: { type: "u8" } },
  },
};

// ── Merkle Batch ─────────────────────────────────────────────────────────────

/**
 * Metadata for a Merkle batch of warm-path events.
 *
 * Stored alongside the batch content in S3 for verification.
 */
export interface MerkleBatchRecord {
  /** Merkle root hash over the event hashes in this batch. */
  merkleRoot: Uint8Array;
  /** Number of events in this batch. */
  eventCount: number;
  /** Sequence number of the first event in the batch. */
  seqStart: bigint;
  /** Sequence number of the last event in the batch. */
  seqEnd: bigint;
  /** Unix timestamp (ms) when the batch was flushed. */
  flushedAt: bigint;
}

/** Borsh schema for MerkleBatchRecord. */
export const MerkleBatchRecordSchema: Schema = {
  struct: {
    merkleRoot: { array: { type: "u8", len: 32 } },
    eventCount: "u32",
    seqStart: "u64",
    seqEnd: "u64",
    flushedAt: "u64",
  },
};

// ── Helper: Create event records from high-level inputs ──────────────────────

/** Input for creating a ledger event (before serialization). */
export interface LedgerEventInput {
  actorDid: string;
  actorType: ActorType;
  action: string;
  scopeType: ScopeType;
  scopeId: string;
  /** Raw content (will be wrapped in ContentEnvelope, hashed, and stored). */
  content: Uint8Array;
  /** Content MIME type. Defaults to "application/json". */
  contentType?: string;
  /** Event tier for storage routing. Defaults to Warm. */
  tier?: EventTier;
}

// ── Tier classification for known actions ────────────────────────────────────

/** Actions that go directly to cold storage (governance significance). */
const COLD_ACTIONS = new Set([
  "proposal.create",
  "proposal.amend",
  "vote.cast",
  "vote.tally",
  "resolution.pass",
  "resolution.fail",
  "meeting.convene",
  "meeting.adjourn",
  "board.resolution",
  "grant.create",
  "grant.revoke",
  "contract.create",
  "contract.revoke",
  "identity.create",
  "identity.rotate",
  "identity.revoke",
  "device.enroll",
  "device.revoke",
  "maturity.promote",
  "maturity.demote",
  "soc.alert",
  "soc.freeze",
  "soc.unfreeze",
  "tenant.create",
  "tenant.update",
  "project.create",
  "project.archive",
]);

/** Actions that are hot-path only (no persistence, dashboard only). */
const HOT_ACTIONS = new Set(["agent.heartbeat", "agent.typing"]);

/** Classify an action into its default event tier. */
export function classifyAction(action: string): EventTier {
  if (HOT_ACTIONS.has(action)) {
    return EventTier.Hot;
  }
  if (COLD_ACTIONS.has(action)) {
    return EventTier.Cold;
  }
  return EventTier.Warm;
}
