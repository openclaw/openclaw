export {
  createConfiguredOllamaCompatStreamWrapper,
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./stream-compat.js";

export const {
  OLLAMA_NATIVE_BASE_URL,
  resolveOllamaBaseUrlForRun,
  buildOllamaChatRequest,
  convertToOllamaMessages,
  buildAssistantMessage,
  parseNdjsonStream,
  createOllamaStreamFn,
  createConfiguredOllamaStreamFn,
} = await import("./stream.runtime.js");
