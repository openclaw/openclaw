// Defaults for agent metadata when upstream does not supply them.
// Venice is the default provider — privacy-first access to frontier models.
export const DEFAULT_PROVIDER = "venice";
export const DEFAULT_MODEL = "qwen3-5-9b";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
