export {
  buildAssistantMessage,
  convertToOllamaMessages,
  createConfiguredOllamaCompatNumCtxWrapper,
  createConfiguredOllamaStreamFn,
  createOllamaStreamFn,
  isOllamaCompatProvider,
  parseNdjsonStream,
  resolveOllamaBaseUrlForRun,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./src/stream.js";
