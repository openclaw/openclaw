// ---------------------------------------------------------------------------
// void-reflection · types
// ---------------------------------------------------------------------------

/** A single lightweight observation captured after every agent run. */
export type Observation = {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Session key of the run (e.g. "main:telegram:123") */
  sessionKey: string;
  /** Whether the run completed successfully */
  success: boolean;
  /** Error message if the run failed */
  error?: string;
  /** Wall-clock duration in milliseconds */
  durationMs?: number;
  /** Number of tool calls made during the run */
  toolCount: number;
  /** Number of messages exchanged (user + assistant) */
  messageCount: number;
};

/** Parsed configuration for the void-reflection plugin. */
export type VoidReflectionConfig = {
  /** Hours between scheduled reflection cycles (default: 6) */
  cronIntervalHours: number;
  /** Number of agent runs before triggering threshold reflection (default: 10) */
  thresholdRuns: number;
  /** Maximum observations to retain in the JSONL log (default: 200) */
  maxObservations: number;
  /** Optional model override for the reflection LLM call */
  reflectionModel: string | null;
};

/** Minimal information the reflector writes alongside the markdown. */
export type ReflectionMeta = {
  /** ISO-8601 timestamp of the reflection */
  timestamp: string;
  /** Number of observations that were analysed */
  observationsAnalysed: number;
  /** File path of the archived reflection */
  archivePath: string;
};
