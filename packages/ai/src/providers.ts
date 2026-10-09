/** Lazy built-in protocol adapter registration. */
export {
  BUILT_IN_API_PROVIDER_SOURCE_ID,
  registerBuiltInApiProviders,
  resetApiProviders,
} from "./providers/register-builtins.js";
export {
  clampOpenAIPromptCacheKey,
  OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
} from "./providers/openai-prompt-cache.js";
// Callers that size a request before dispatch must reserve the same thinking allowance.
export { adjustMaxTokensForThinking } from "./providers/simple-options.js";
