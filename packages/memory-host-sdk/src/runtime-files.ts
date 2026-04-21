// Focused runtime contract for memory file/backend access.

export type { DreamDiaryBackfillEntry } from "./host/dream-diary-backfill.js";
export type { DailyMemoryFileEntry } from "./host/daily-files.js";
export type { DailyMemoryPathInfo, ParsedDailyMemoryFileName } from "./host/daily-paths.js";
export type { SessionSummaryDailyMemoryDependency } from "./host/daily-content.js";
export {
  areSessionSummaryDailyMemoryDependenciesCurrent,
  buildSessionSummaryDailyMemoryProbePaths,
  filterOutSessionSummaryDailyMemoryFiles,
  filterSessionSummaryDailyMemoryFiles,
  isBenignSessionSummaryDailyMemoryProbeError,
  isLikelyMissingSessionSummaryDailyMemory,
  isLikelySessionSummaryDailyMemorySnippet,
  isSessionSummaryDailyMemory,
  isSessionSummaryDailyMemoryPath,
  SESSION_SUMMARY_DAILY_MEMORY_SENTINEL,
} from "./host/daily-content.js";
export { collectDreamDiaryBackfillEntries } from "./host/dream-diary-backfill.js";
export {
  listDailyMemoryFiles,
  listRecentDailyMemoryFiles,
  rememberRecentDailyMemoryFile,
} from "./host/daily-files.js";
export {
  DAILY_MEMORY_FILE_NAME_RE,
  compareDailyVariantPathPreference,
  extractDailyMemoryDayFromPath,
  isDailyMemoryFileName,
  isSupportedShortTermMemoryPath,
  parseDailyMemoryFileName,
  parseDailyMemoryPathInfo,
  resolveDailyMemoryVariantMergeKey,
} from "./host/daily-paths.js";
export { listMemoryFiles, normalizeExtraMemoryPaths } from "./host/internal.js";
export { readAgentMemoryFile } from "./host/read-file.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export type {
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
} from "./host/types.js";
