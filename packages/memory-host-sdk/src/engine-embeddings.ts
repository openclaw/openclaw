// Real workspace contract for memory embedding providers and batch helpers.

export type {
	MemoryEmbeddingBatchChunk,
	MemoryEmbeddingBatchOptions,
	MemoryEmbeddingProvider,
	MemoryEmbeddingProviderAdapter,
	MemoryEmbeddingProviderCreateOptions,
	MemoryEmbeddingProviderCreateResult,
	MemoryEmbeddingProviderRuntime,
} from "../../../src/plugins/memory-embedding-providers.js";
export {
	getMemoryEmbeddingProvider,
	listMemoryEmbeddingProviders,
} from "../../../src/plugins/memory-embedding-providers.js";
export {
	type GeminiBatchRequest,
	runGeminiEmbeddingBatches,
} from "./host/batch-gemini.js";
export {
	OPENAI_BATCH_ENDPOINT,
	type OpenAiBatchRequest,
	runOpenAiEmbeddingBatches,
} from "./host/batch-openai.js";
export {
	runVoyageEmbeddingBatches,
	type VoyageBatchRequest,
} from "./host/batch-voyage.js";
export { enforceEmbeddingMaxInputTokens } from "./host/embedding-chunk-limits.js";
export {
	estimateStructuredEmbeddingInputBytes,
	estimateUtf8Bytes,
} from "./host/embedding-input-limits.js";
export {
	type EmbeddingInput,
	hasNonTextEmbeddingParts,
} from "./host/embedding-inputs.js";
export {
	createLocalEmbeddingProvider,
	DEFAULT_LOCAL_MODEL,
} from "./host/embeddings.js";
export {
	buildGeminiEmbeddingRequest,
	createGeminiEmbeddingProvider,
	DEFAULT_GEMINI_EMBEDDING_MODEL,
} from "./host/embeddings-gemini.js";
export {
	createMistralEmbeddingProvider,
	DEFAULT_MISTRAL_EMBEDDING_MODEL,
} from "./host/embeddings-mistral.js";
export type { OllamaEmbeddingClient } from "./host/embeddings-ollama.js";
export {
	createOllamaEmbeddingProvider,
	DEFAULT_OLLAMA_EMBEDDING_MODEL,
} from "./host/embeddings-ollama.js";
export {
	createOpenAiEmbeddingProvider,
	DEFAULT_OPENAI_EMBEDDING_MODEL,
} from "./host/embeddings-openai.js";
export {
	createVoyageEmbeddingProvider,
	DEFAULT_VOYAGE_EMBEDDING_MODEL,
} from "./host/embeddings-voyage.js";
export {
	buildCaseInsensitiveExtensionGlob,
	classifyMemoryMultimodalPath,
	getMemoryMultimodalExtensions,
} from "./host/multimodal.js";
