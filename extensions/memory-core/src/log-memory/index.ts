// Barrel for the log-memory subsystem. Internal to extensions/memory-core;
// promote selected entries through ./api.ts when an external caller needs them.
export type {
  ConsolidateFn,
  ConsolidatedPattern,
  DreamRecord,
  EmbedFn,
  LogMemoryEntry,
  LogMemoryLayer,
  LogMemoryPayload,
  LogMemoryPayloadType,
  LogMemorySource,
} from "./types.js";
export { computeCurrentDecay, computeInitialDecay } from "./decay.js";
export { computeEntryId } from "./dedupe.js";
export { parseLogLine, type ParsedLogLine } from "./parse.js";
export { approxTokenCount, slidingWindowChunks } from "./chunk.js";
export {
  bufferToEmbedding,
  cosineSimilarity,
  embeddingToBuffer,
  LogMemoryStore,
  type LogMemoryHybridResult,
  type UpsertInput,
  vectorNorm,
} from "./store.js";
export { greedyClusterByCosine, type Cluster } from "./cluster.js";
export {
  DEFAULT_DREAM_THRESHOLD,
  LogIngestor,
  type DreamTrigger,
  type IngestMeta,
  type IngestResult,
} from "./ingestor.js";
export {
  detectTeachingMoment,
  KnowledgeCapture,
  type KnowledgeCaptureRecord,
} from "./knowledge-capture.js";
export { runDreamCycle, type DreamCycleOptions, type DreamCycleResult } from "./dream.js";
export { DreamScheduler, DREAM_DAILY_CRON, type DreamSchedulerDeps } from "./scheduler.js";
export { ensureLogAnalystSkill, LOG_ANALYST_SKILL_BODY, type EnsureSkillResult } from "./skill.js";
