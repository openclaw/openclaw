// Defaults for agent metadata when upstream does not supply them.
// Model id uses pi-ai's built-in Anthropic catalog.
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;

// Well-known context windows for popular models. Used as an intermediate
// fallback when the pi-ai ModelRegistry doesn't resolve model metadata
// (e.g. OAuth sessions) and no explicit provider config exists.
export const WELL_KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-5-20250929": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-20250514": 200_000,
};

// Well-known max output tokens for popular models.
export const WELL_KNOWN_MAX_TOKENS: Record<string, number> = {
  "claude-opus-4-6": 32_000,
  "claude-sonnet-4-5-20250929": 16_000,
  "claude-haiku-4-5-20251001": 16_000,
  "claude-sonnet-4-20250514": 16_000,
};
