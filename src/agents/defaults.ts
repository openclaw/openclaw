// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
