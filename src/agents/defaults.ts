// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
