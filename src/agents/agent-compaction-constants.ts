/**
 * Absolute minimum prompt budget in tokens.  When the context window is
 * large enough that `contextTokenBudget * MIN_PROMPT_BUDGET_RATIO` exceeds
 * this value, this absolute floor takes precedence.
 */
export const MIN_PROMPT_BUDGET_TOKENS = 8_000;

/**
 * Minimum share of the context window that must remain available for prompt
 * content after reserve tokens are subtracted.
 */
export const MIN_PROMPT_BUDGET_RATIO = 0.5;

/**
 * Larger minimum prompt share used when the run boots in a lightweight
 * bootstrap context (no/limited history). Lightweight runs have nothing to
 * compact, so reserving half the window for model output is excessive — give
 * the prompt most of the context and let the provider handle any small
 * remainder. Keeps small-context models (e.g. phi3:mini at 4,096 tokens)
 * usable for isolated cron jobs.
 */
export const MIN_PROMPT_BUDGET_RATIO_LIGHTWEIGHT = 0.8;
