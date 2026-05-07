// Public types for the log-memory subsystem. Lives inside memory-core because
// memory layering, decay, and dream consolidation are owner-scoped concerns.

export type LogMemoryLayer = "episodic" | "semantic" | "procedural";

export type LogMemoryPayloadType =
  | "raw_log"
  | "error_pattern"
  | "incident_summary"
  | "engineer_knowledge";

export type LogMemorySource = "log_ingest" | "engineer_teach" | "dream_consolidation";

export interface LogMemoryPayload {
  type: LogMemoryPayloadType;
  content: string;
  tags: string[];
  source: LogMemorySource;
  decayScore: number;
  accessCount: number;
  lastAccessedAt: Date;
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
