// Focused runtime contract for memory file/backend access.

export {
  listMemoryFiles,
  normalizeExtraMemoryPaths,
} from "../../../src/plugins/memory-host/internal.js";
export { readAgentMemoryFile } from "../../../src/plugins/memory-host/read-file.js";
export { resolveMemoryBackendConfig } from "../../../src/plugins/memory-host/backend-config.js";
export type { MemorySearchResult } from "../../../src/plugins/memory-host/types.js";
