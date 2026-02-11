/**
 * Graph schema types, Cypher query templates, and constants for memory-neo4j.
 */

// ============================================================================
// Shared Types
// ============================================================================

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

// ============================================================================
// Node Types
// ============================================================================

export type MemoryCategory = "core" | "preference" | "fact" | "decision" | "entity" | "other";
export type EntityType = "person" | "organization" | "location" | "event" | "concept";
export type ExtractionStatus = "pending" | "complete" | "failed" | "skipped";
export type MemorySource =
  | "user"
  | "auto-capture"
  | "auto-capture-assistant"
  | "memory-watcher"
  | "import";

export type MemoryNode = {
  id: string;
  text: string;
  embedding: number[];
  importance: number;
  category: MemoryCategory;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  extractionStatus: ExtractionStatus;
  extractionRetries: number;
  agentId: string;
  sessionKey?: string;
  retrievalCount: number;
  lastRetrievedAt?: string;
  promotedAt?: string;
  userPinned?: boolean;
};

export type EntityNode = {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  description?: string;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
};

export type TagNode = {
  id: string;
  name: string;
  category: string;
  createdAt: string;
};

// ============================================================================
// Extraction Types
// ============================================================================

export type ExtractedEntity = {
  name: string;
  type: EntityType;
  aliases?: string[];
  description?: string;
};

export type ExtractedRelationship = {
  source: string;
  target: string;
  type: string;
  confidence: number;
};

export type ExtractedTag = {
  name: string;
  category: string;
};

export type ExtractionResult = {
  category?: MemoryCategory;
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
  tags: ExtractedTag[];
};

// ============================================================================
// Search Types
// ============================================================================

export type SearchSignalResult = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  score: number;
};

export type HybridSearchResult = {
  id: string;
  text: string;
  category: string;
  importance: number;
  createdAt: string;
  score: number;
};

// ============================================================================
// Input Types
// ============================================================================

export type StoreMemoryInput = {
  id: string;
  text: string;
  embedding: number[];
  importance: number;
  category: MemoryCategory;
  source: MemorySource;
  extractionStatus: ExtractionStatus;
  agentId: string;
  sessionKey?: string;
  userPinned?: boolean;
};

export type MergeEntityInput = {
  id: string;
  name: string;
  type: EntityType;
  aliases?: string[];
  description?: string;
};

// ============================================================================
// Constants
// ============================================================================

export const MEMORY_CATEGORIES = [
  "core",
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
] as const;

export const ENTITY_TYPES = ["person", "organization", "location", "event", "concept"] as const;

export const ALLOWED_RELATIONSHIP_TYPES = new Set([
  "WORKS_AT",
  "LIVES_AT",
  "KNOWS",
  "MARRIED_TO",
  "PREFERS",
  "DECIDED",
  "RELATED_TO",
]);

// ============================================================================
// Lucene Helpers
// ============================================================================

const LUCENE_SPECIAL_CHARS = /[+\-&|!(){}[\]^"~*?:\\/]/g;

/**
 * Escape special characters for Lucene fulltext search queries.
 */
export function escapeLucene(query: string): string {
  return query.replace(LUCENE_SPECIAL_CHARS, "\\$&");
}

/**
 * Validate that a relationship type is in the allowed set.
 * Prevents Cypher injection via dynamic relationship type.
 */
export function validateRelationshipType(type: string): boolean {
  return ALLOWED_RELATIONSHIP_TYPES.has(type);
}

/**
 * Create a canonical key for a pair of IDs (sorted for order-independence).
 */
export function makePairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
