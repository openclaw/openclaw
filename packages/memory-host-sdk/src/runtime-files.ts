// Focused runtime contract for memory file/backend access.

export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export { listMemoryFiles, normalizeExtraMemoryPaths } from "./host/internal.js";
export { readAgentMemoryFile } from "./host/read-file.js";
export type { MemorySearchResult } from "./host/types.js";
