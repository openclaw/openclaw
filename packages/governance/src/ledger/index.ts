/**
 * Governance Ledger — public API.
 *
 * @example
 * ```ts
 * import { Ledger, InMemoryContentStore, ActorType, ScopeType } from "@six-fingered-man/governance/ledger";
 *
 * const ledger = new Ledger({
 *   store: new InMemoryContentStore(),
 *   flushThreshold: 50,
 *   onEvent: (e) => console.log(`[${e.action}] ${e.actorDid}`),
 * });
 *
 * await ledger.append({
 *   actorDid: "did:key:z6Mk...",
 *   actorType: ActorType.Agent,
 *   action: "agent.message",
 *   scopeType: ScopeType.Project,
 *   scopeId: "bhr",
 *   content: new TextEncoder().encode(JSON.stringify({ text: "Task complete" })),
 * });
 *
 * await ledger.flush();
 * ```
 */

// Main class
export { Ledger } from "./ledger.js";
export type { LedgerConfig } from "./ledger.js";

// Schemas & types
export {
  ActorType,
  ScopeType,
  EventTier,
  classifyAction,
  LedgerEventRecordSchema,
  ContentEnvelopeSchema,
  MerkleBatchRecordSchema,
} from "./schemas.js";
export type {
  LedgerEventRecord,
  ContentEnvelope,
  MerkleBatchRecord,
  LedgerEventInput,
} from "./schemas.js";

// Serialization
export {
  serializeEvent,
  deserializeEvent,
  serializeContent,
  deserializeContent,
  serializeBatch,
  deserializeBatch,
  hash,
  hashEvent,
  hashContent,
  GENESIS_HASH,
} from "./serializer.js";

// Merkle tree
export { buildMerkleTree, getMerkleRoot, getMerkleProof, verifyMerkleProof } from "./merkle.js";
export type { MerkleProof } from "./merkle.js";

// Content stores
export { InMemoryContentStore, S3ContentStore } from "./store.js";
export type { ContentStore, ContentStoreConfig } from "./store.js";

// Buffer
export { EventBuffer, decodeHashList } from "./buffer.js";
export type { EventBufferConfig } from "./buffer.js";
