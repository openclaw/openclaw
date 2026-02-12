// Defaults for agent metadata when upstream does not supply them.
// Model id uses Google Gemini.
export const DEFAULT_PROVIDER = "google";
export const DEFAULT_MODEL = "gemini-2.0-flash";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 1_000_000;
