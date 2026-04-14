// Sonnet pricing per spec (conservative — no cache discount applied):
// $3/M input tokens, $15/M output tokens.
const SONNET_IN_PER_M = 3.00;
const SONNET_OUT_PER_M = 15.00;

export function createBudgetTracker(capUsd) {
  let spent = 0;
  return {
    record({ inputTokens, outputTokens }) {
      spent += (inputTokens / 1_000_000) * SONNET_IN_PER_M;
      spent += (outputTokens / 1_000_000) * SONNET_OUT_PER_M;
    },
    spent: () => spent,
    remaining: () => Math.max(0, capUsd - spent),
    canAfford: (estimateUsd) => (spent + estimateUsd) <= capUsd,
  };
}
