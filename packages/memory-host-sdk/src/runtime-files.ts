// Focused runtime contract for memory file/backend access.

export type { DreamDiaryBackfillEntry } from "./host/dream-diary-backfill.js";
export type { DailyMemoryFileEntry } from "./host/daily-files.js";
export type { DailyMemoryPathInfo, ParsedDailyMemoryFileName } from "./host/daily-paths.js";
export {
  filterSessionSummaryDailyMemoryFiles,
  isSessionSummaryDailyMemory,
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
  parseDailyMemoryFileName,
  parseDailyMemoryPathInfo,
} from "./host/daily-paths.js";
export { listMemoryFiles, normalizeExtraMemoryPaths } from "./host/internal.js";
export { readAgentMemoryFile } from "./host/read-file.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export type {
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
} from "./host/types.js";
