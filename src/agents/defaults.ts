// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Context window: Opus 4.6 supports 1M tokens.
export const DEFAULT_CONTEXT_TOKENS = 1_000_000;
