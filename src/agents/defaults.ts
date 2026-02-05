// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Context window: Opus supports ~200k tokens (per pi-ai models.generated.ts for Opus 4.5).
export const DEFAULT_CONTEXT_TOKENS = 200_000;
