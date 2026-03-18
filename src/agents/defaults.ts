// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Fallback used when model metadata is unavailable.
// Updated to 1M to match Anthropic's March 2026 GA announcement for
// Claude Opus 4.6 and Sonnet 4.6 (https://claude.com/blog/1m-context-ga).
export const DEFAULT_CONTEXT_TOKENS = 1_000_000;
