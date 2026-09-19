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
export {
  ANTHROPIC_CLAUDE_CODE_IDENTITY_TIMEOUT_MS,
  ANTHROPIC_CLAUDE_CODE_VERSION,
  type AnthropicClaudeCodeIdentity,
  deferAnthropicClaudeCodeIdentityUntil,
  getAnthropicClaudeCodeVersion,
  resetAnthropicClaudeCodeVersionForTests,
  resolveAnthropicClaudeCodeIdentity,
  setAnthropicClaudeCodeVersion,
  snapshotAnthropicClaudeCodeIdentity,
} from "./providers/anthropic-model-contract.js";
