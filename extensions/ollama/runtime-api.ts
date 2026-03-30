export {
	createOllamaEmbeddingProvider,
	DEFAULT_OLLAMA_EMBEDDING_MODEL,
	type OllamaEmbeddingClient,
	type OllamaEmbeddingProvider,
} from "./src/embedding-provider.js";
export {
	buildAssistantMessage,
	buildOllamaChatRequest,
	convertToOllamaMessages,
	createConfiguredOllamaCompatNumCtxWrapper,
	createConfiguredOllamaCompatStreamWrapper,
	createConfiguredOllamaStreamFn,
	createOllamaStreamFn,
	isOllamaCompatProvider,
	OLLAMA_NATIVE_BASE_URL,
	parseNdjsonStream,
	resolveOllamaBaseUrlForRun,
	resolveOllamaCompatNumCtxEnabled,
	shouldInjectOllamaCompatNumCtx,
	wrapOllamaCompatNumCtx,
} from "./src/stream.js";
