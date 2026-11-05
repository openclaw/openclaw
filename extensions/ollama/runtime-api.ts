export {
  buildAssistantMessage,
  buildOllamaChatRequest,
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  OLLAMA_NATIVE_BASE_URL,
  type OllamaStreamTransport,
  resolveOllamaBaseUrlForRun,
} from "./src/stream.runtime.js";
export {
  createConfiguredOllamaCompatStreamWrapper,
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./src/stream-compat.js";
export { parseNdjsonStream } from "./src/stream-ndjson.js";
export {
  createOllamaEmbeddingProvider,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  type OllamaEmbeddingClient,
  type OllamaEmbeddingProvider,
} from "./src/embedding-provider.js";
