// Public types for the log-memory subsystem. The store is now Markdown-file
// based; embeddings are no longer persisted with each entry — they are
// computed on-the-fly via the injected EmbedFn whenever search or dream
// consolidation needs them.

export type LogMemoryLayer = "episodic" | "semantic" | "procedural";

export type LogMemoryPayloadType =
  | "raw_log"
  | "error_pattern"
  | "incident_summary"
  | "engineer_knowledge"
  | "conversation_rule";

export type LogMemorySource = "log_ingest" | "engineer_teach" | "dream_consolidation";

export interface LogMemoryPayload {
  type: LogMemoryPayloadType;
  content: string;
  tags: string[];
  source: LogMemorySource;
  decayScore: number;
  // When true, this entry is exempt from decay and will never be consumed by
  // the dream cycle. Use for rules/conventions that must survive indefinitely.
  pinned?: boolean;
  accessCount: number;
  lastAccessedAt: Date;
  // Set by the dream cycle when this entry has been consolidated into a
  // semantic block. Once set, default loads/queries skip the entry but the
  // raw block stays on disk for audit/replay. Mirrors the `promotedAt` flag
  // on ShortTermRecallEntry in short-term-promotion.ts.
  consolidatedAt?: Date;
  // Semantic-only metadata. Episodic blocks leave these undefined.
  title?: string;
  rootCause?: string;
}

export interface LogMemoryEntry {
  id: string;
  timestamp: Date;
  layer: LogMemoryLayer;
  embedding?: Float32Array;
  payload: LogMemoryPayload;
}

export interface DreamRecord {
  dreamId: string;
  triggeredAt: Date;
  trigger: "cron" | "threshold" | "manual";
  episodicConsumed: number;
  semanticProduced: number;
  durationMs: number;
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

// Consolidation hook called by the dream cycle. Returns null when the LLM
// reply was unparseable so the cluster can be skipped without aborting the run.
export type ConsolidateFn = (input: {
  members: LogMemoryEntry[];
}) => Promise<ConsolidatedPattern | null>;

export interface ConsolidatedPattern {
  title: string;
  pattern: string;
  rootCause: string;
  tags: string[];
}
