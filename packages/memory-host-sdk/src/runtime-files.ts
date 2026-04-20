// Focused runtime contract for memory file/backend access.

export type { DailyMemoryFileEntry, ParsedDailyMemoryFileName } from "./host/daily-files.js";
export {
  DAILY_MEMORY_FILE_NAME_RE,
  filterSessionSummaryDailyMemoryFiles,
  isDailyMemoryFileName,
  isSessionSummaryDailyMemory,
  listDailyMemoryFiles,
  listRecentDailyMemoryFiles,
  parseDailyMemoryFileName,
  rememberRecentDailyMemoryFile,
} from "./host/daily-files.js";
export { listMemoryFiles, normalizeExtraMemoryPaths } from "./host/internal.js";
export { readAgentMemoryFile } from "./host/read-file.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export type {
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
} from "./host/types.js";
