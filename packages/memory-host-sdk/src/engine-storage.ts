// Real workspace contract for memory engine storage/index helpers.

export type {
	ResolvedMemoryBackendConfig,
	ResolvedQmdConfig,
	ResolvedQmdMcporterConfig,
} from "./host/backend-config.js";
export { resolveMemoryBackendConfig } from "./host/backend-config.js";
export { isFileMissingError, statRegularFile } from "./host/fs-utils.js";
export {
	buildFileEntry,
	buildMultimodalChunkForIndexing,
	chunkMarkdown,
	cosineSimilarity,
	ensureDir,
	hashText,
	listMemoryFiles,
	type MemoryChunk,
	type MemoryFileEntry,
	normalizeExtraMemoryPaths,
	parseEmbedding,
	remapChunkLines,
	runWithConcurrency,
} from "./host/internal.js";
export { ensureMemoryIndexSchema } from "./host/memory-schema.js";
export { readMemoryFile } from "./host/read-file.js";
export { requireNodeSqlite } from "./host/sqlite.js";
export { loadSqliteVecExtension } from "./host/sqlite-vec.js";
export type {
	MemoryEmbeddingProbeResult,
	MemoryProviderStatus,
	MemorySearchManager,
	MemorySearchResult,
	MemorySource,
	MemorySyncProgressUpdate,
} from "./host/types.js";
