// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Context window: default fallback when model contextWindow is not available.
// Gemini 3 supports up to 1M tokens.
export const DEFAULT_CONTEXT_TOKENS = 1_000_000;
