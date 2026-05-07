export type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
export {
  dedupeDreamDiaryEntries,
  removeBackfillDiaryEntries,
  writeBackfillDiaryEntries,
} from "./src/dreaming-narrative.js";
export { previewGroundedRemMarkdown } from "./src/rem-evidence.js";
export { filterRecallEntriesWithinLookback } from "./src/dreaming-phases.js";
export { previewRemHarness } from "./src/rem-harness.js";
export type { PreviewRemHarnessOptions, PreviewRemHarnessResult } from "./src/rem-harness.js";
export {
  computeCurrentDecay,
  computeInitialDecay,
  detectTeachingMoment,
  DREAM_DAILY_CRON,
  LOG_ANALYST_SKILL_BODY,
  parseLogLine,
} from "./src/log-memory/index.js";
export type {
  ConsolidateFn,
  ConsolidatedPattern,
  DreamCycleOptions,
  DreamCycleResult,
  DreamRecord,
  EmbedFn,
  LogMemoryEntry,
  LogMemoryLayer,
  LogMemoryPayload,
  LogMemoryPayloadType,
  LogMemorySource,
} from "./src/log-memory/index.js";
