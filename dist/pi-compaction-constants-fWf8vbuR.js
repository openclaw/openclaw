//#region src/agents/pi-compaction-constants.ts
/**
* Absolute minimum prompt budget in tokens.  When the context window is
* large enough that `contextTokenBudget * MIN_PROMPT_BUDGET_RATIO` exceeds
* this value, this absolute floor takes precedence.
*/
const MIN_PROMPT_BUDGET_TOKENS = 8e3;
/**
* Minimum share of the context window that must remain available for prompt
* content after reserve tokens are subtracted.
*/
const MIN_PROMPT_BUDGET_RATIO = .5;
//#endregion
export { MIN_PROMPT_BUDGET_TOKENS as n, MIN_PROMPT_BUDGET_RATIO as t };
