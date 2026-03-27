// Real workspace contract for memory embedding providers and batch helpers.

export {
  getMemoryEmbeddingProvider,
  listMemoryEmbeddingProviders,
} from "../../../src/plugins/memory-embedding-providers.js";
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
  createLocalEmbeddingProvider,
  DEFAULT_LOCAL_MODEL,
} from "../../../src/plugins/memory-host/embeddings.js";
export {
  createGeminiEmbeddingProvider,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  buildGeminiEmbeddingRequest,
} from "../../../src/plugins/memory-host/embeddings-gemini.js";
export {
  createMistralEmbeddingProvider,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
} from "../../../src/plugins/memory-host/embeddings-mistral.js";
export {
  createOllamaEmbeddingProvider,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
} from "../../../src/plugins/memory-host/embeddings-ollama.js";
export {
  createOpenAiEmbeddingProvider,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
} from "../../../src/plugins/memory-host/embeddings-openai.js";
export {
  createVoyageEmbeddingProvider,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
} from "../../../src/plugins/memory-host/embeddings-voyage.js";
export {
  runGeminiEmbeddingBatches,
  type GeminiBatchRequest,
} from "../../../src/plugins/memory-host/batch-gemini.js";
export {
  OPENAI_BATCH_ENDPOINT,
  runOpenAiEmbeddingBatches,
  type OpenAiBatchRequest,
} from "../../../src/plugins/memory-host/batch-openai.js";
export {
  runVoyageEmbeddingBatches,
  type VoyageBatchRequest,
} from "../../../src/plugins/memory-host/batch-voyage.js";
export { enforceEmbeddingMaxInputTokens } from "../../../src/plugins/memory-host/embedding-chunk-limits.js";
export {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "../../../src/plugins/memory-host/embedding-input-limits.js";
export {
  hasNonTextEmbeddingParts,
  type EmbeddingInput,
} from "../../../src/plugins/memory-host/embedding-inputs.js";
export {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "../../../src/plugins/memory-host/multimodal.js";
