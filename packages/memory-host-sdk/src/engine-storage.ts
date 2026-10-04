// Real workspace contract for memory engine storage/index helpers.
export type { MemoryWorkspaceFiles, MemoryWorkspaceWatchRequest } from "./host/workspace-files.js";

export {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  encodeMemoryEmbedding,
  decodeMemoryEmbedding,
  hashText,
  INVALID_PROJECT_ANNOTATION_KEY,
  listMemoryFiles,
  matchesExtraMemoryPathEntry,
  MEMORY_CHUNKING_VERSION,
  normalizeExtraMemoryPathEntries,
  runWithConcurrency,
  stripMemoryAnnotationCarriers,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./host/internal.js";
export { readMemoryFile } from "./host/read-file.js";
export { retryTransientMemoryRead } from "./host/read-retry.js";
export { type MemoryReadResult } from "./host/read-file-shared.js";
export {
  formatMemoryIndexRebuildGuidance,
  resolveMemoryIndexIdentityDiagnostic,
  resolveMemoryIndexSearchDiagnostic,
  resolveMemorySearchStaleness,
} from "./host/types.js";
export {
  createMemorySearchDeadlineControl,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemorySearchDeadlineControl,
  type MemorySearchDeadlineControlOptions,
} from "./host/search-deadline-control.js";
export type {
  MemoryEntryProvenance,
  MemoryExtraPath,
  MemoryIndexIdentityDiagnostic,
  MemoryIndexIdentityState,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchRuntimeDebug,
  MemorySearchResult,
  MemorySessionSyncTarget,
  MemorySource,
  MemorySyncParams,
  MemorySyncProgressUpdate,
  MemoryVectorIndexState,
} from "./host/types.js";
export {
  ensureMemoryChunkProvenance,
  ensureMemoryIndexSchema,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_DERIVED_TABLES,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_META_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "./host/memory-schema.js";
export { loadSqliteVecExtension, loadSqliteVecExtensionFromPath } from "./host/sqlite-vec.js";
export {
  readCuratedProjectMemoryCandidates,
  readCuratedMemoryTriggerCandidates,
  readMemoryRecallMetadata,
} from "./host/memory-recall-metadata.js";
export {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  requireNodeSqlite,
  stopMemorySqliteWalMaintenance,
} from "./host/sqlite.js";
export { isFileMissingError } from "./host/fs-utils.js";
