// Focused runtime contract for memory file/backend access.

export { listMemoryFiles, normalizeExtraMemoryPaths } from "./host/internal.js";
export { readAgentMemoryFile } from "./host/read-file.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export {
  buildContinuityManifest,
  formatContinuityManifest,
  formatContinuitySnapshotForPrompt,
  hasMaterialContinuityChange,
  parseContinuityDocument,
  readRecentContinuitySnapshot,
  RECENT_CONTINUITY_DIR,
  RECENT_CONTINUITY_LATEST,
  RECENT_CONTINUITY_SNAPSHOTS_DIR,
  renderContinuitySnapshotMarkdown,
} from "./host/continuity.js";
export type {
  ContinuityManifestEntry,
  ContinuitySnapshotState,
  ParsedContinuityDocument,
} from "./host/continuity.js";
export type {
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
} from "./host/types.js";
