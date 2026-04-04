export {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_DEFAULT_MODEL,
} from "./src/defaults.js";
export {
  buildOllamaModelDefinition,
  detectVisionFromShowResponse,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  isReasoningModelHeuristic,
  isVisionModelHeuristic,
  queryOllamaContextWindow,
  queryOllamaModelMeta,
  resolveOllamaApiBase,
  type OllamaModelMeta,
  type OllamaModelWithContext,
  type OllamaTagModel,
  type OllamaTagsResponse,
} from "./src/provider-models.js";
export {
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./src/setup.js";
export {
  buildOllamaChatRequest,
  createConfiguredOllamaCompatStreamWrapper,
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./src/stream.js";
