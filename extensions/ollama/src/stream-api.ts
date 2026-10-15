export { parseNdjsonStream } from "./stream-ndjson.js";
export { convertToOllamaMessages } from "./stream-messages.js";
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
  buildAssistantMessage,
  createOllamaStreamFn,
  createConfiguredOllamaStreamFn,
} = await import("./stream.runtime.js");
