export { parseNdjsonStream } from "./stream-ndjson.js";
export type { OllamaStreamTransport } from "./stream.runtime.js";
export {
  createConfiguredOllamaCompatStreamWrapper,
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./stream-compat.js";

export {
  OLLAMA_NATIVE_BASE_URL,
  resolveOllamaBaseUrlForRun,
  buildOllamaChatRequest,
  buildAssistantMessage,
  createOllamaStreamFn,
  createConfiguredOllamaStreamFn,
} from "./stream.runtime.js";
