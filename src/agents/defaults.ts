// Defaults for agent metadata when upstream does not supply them.
// Note: DEFAULT_PROVIDER and DEFAULT_MODEL are now conditional - see resolveDefaultModelRef()
// which checks for available credentials before using these fallbacks.
// These values are kept for backward compatibility but should not be used directly.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
