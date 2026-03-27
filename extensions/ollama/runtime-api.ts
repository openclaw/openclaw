export {
  buildAssistantMessage,
  convertToOllamaMessages,
  createConfiguredOllamaCompatNumCtxWrapper,
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
