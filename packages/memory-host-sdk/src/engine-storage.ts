// Real workspace contract for memory engine storage/index helpers.

export {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  cosineSimilarity,
  ensureDir,
  hashText,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  parseEmbedding,
  remapChunkLines,
  runWithConcurrency,
  type MemoryChunk,
  type MemoryFileEntry,
} from "../../../src/plugins/memory-host/internal.js";
export { readMemoryFile } from "../../../src/plugins/memory-host/read-file.js";
export { resolveMemoryBackendConfig } from "../../../src/plugins/memory-host/backend-config.js";
export type {
  ResolvedMemoryBackendConfig,
  ResolvedQmdConfig,
  ResolvedQmdMcporterConfig,
} from "../../../src/plugins/memory-host/backend-config.js";
export type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "../../../src/plugins/memory-host/types.js";
export { ensureMemoryIndexSchema } from "../../../src/plugins/memory-host/memory-schema.js";
export { loadSqliteVecExtension } from "../../../src/plugins/memory-host/sqlite-vec.js";
export { requireNodeSqlite } from "../../../src/plugins/memory-host/sqlite.js";
export { isFileMissingError, statRegularFile } from "../../../src/plugins/memory-host/fs-utils.js";
