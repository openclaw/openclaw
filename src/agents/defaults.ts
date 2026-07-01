// Defaults for agent metadata when upstream does not supply them.
// Keep this aligned with the product-level latest-model baseline.
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-5.5";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
// Conservative fallback for the per-request output token cap when model
// metadata omits it. Mirrors DEFAULT_MODEL_MAX_TOKENS in config/defaults.ts.
// Using a context-window-sized value here lets request budget clamps hand
// providers a `max_completion_tokens` larger than the model's real output cap,
// which they reject with HTTP 400 (see #98295).
export const DEFAULT_MODEL_MAX_TOKENS = 8192;
