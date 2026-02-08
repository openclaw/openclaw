// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Conservative fallback used when model metadata is unavailable.
// Opus 4.6 supports 1M in beta (requires context-1m header + Tier 4/Max),
// but 200k is the safe default for most subscriptions.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
