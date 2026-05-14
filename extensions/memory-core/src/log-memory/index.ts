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
export { parseBlocks, serializeEpisodicBlock, serializeSemanticBlock } from "./md-format.js";
export {
  cosineSimilarity,
  LogMemoryStore,
  vectorNorm,
  type AppendInput,
  type LogMemoryHybridResult,
  type UpsertInput,
} from "./store.js";
export { greedyClusterByCosine, type Cluster } from "./cluster.js";
export {
  DEFAULT_DREAM_THRESHOLD,
  LogIngestor,
  type DreamTrigger,
  type IngestMeta,
  type IngestResult,
  type QueryOptions,
} from "./ingestor.js";
export {
  detectImplicitRule,
  detectTeachingMoment,
  KnowledgeCapture,
  type KnowledgeCaptureRecord,
} from "./knowledge-capture.js";
export { ContextInjector, type ContextInjectorOptions } from "./context-injector.js";
export { runDreamCycle, type DreamCycleOptions, type DreamCycleResult } from "./dream.js";
export { DreamScheduler, DREAM_DAILY_CRON, type DreamSchedulerDeps } from "./scheduler.js";
export { ensureLogAnalystSkill, LOG_ANALYST_SKILL_BODY, type EnsureSkillResult } from "./skill.js";
