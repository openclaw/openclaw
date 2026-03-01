// Defaults for agent metadata when upstream does not supply them.
// Model id uses the Hanzo Cloud provider and zen4 model.
export const DEFAULT_PROVIDER = "hanzo";
export const DEFAULT_MODEL = "zen4";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
