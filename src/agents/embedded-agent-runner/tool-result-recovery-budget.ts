import { resolveLiveToolResultMaxChars } from "../tool-result-limits.js";

const PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER = 4;
const AGGREGATE_TOOL_RESULT_CONTEXT_SHARE = 0.5;

export function resolveLiveToolResultAggregateMaxChars(params: {
  contextWindowTokens: number;
  perResultMaxChars?: number;
}): number {
  const perResultMaxChars = Math.max(
    1,
    Math.floor(
      params.perResultMaxChars ??
        resolveLiveToolResultMaxChars({
          contextWindowTokens: params.contextWindowTokens,
        }),
    ),
  );
  const contextWindowTokens = Number.isFinite(params.contextWindowTokens)
    ? Math.max(1, Math.floor(params.contextWindowTokens))
    : 1;
  // Match the 0.5 safeguard/mid-turn pressure invariant so truncation cannot hide pressure.
  const contextShareChars = Math.floor(
    contextWindowTokens * 4 * AGGREGATE_TOOL_RESULT_CONTEXT_SHARE,
  );
  return Math.max(
    perResultMaxChars * PROMPT_TOOL_RESULT_AGGREGATE_CAP_MULTIPLIER,
    contextShareChars,
  );
}

/** Keep as much tool output as fits the reduction needed by the rejected request. */
export function selectToolResultRecoveryBudget(params: {
  aggregateBudgetChars: number;
  requiredTokenReduction: number;
  reductionAtBudget: (budget: number) => number;
}): number {
  const { aggregateBudgetChars, requiredTokenReduction, reductionAtBudget } = params;
  if (requiredTokenReduction <= reductionAtBudget(aggregateBudgetChars)) {
    return aggregateBudgetChars;
  }
  if (requiredTokenReduction > reductionAtBudget(1)) {
    return 1;
  }
  let low = 1;
  let high = aggregateBudgetChars;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (reductionAtBudget(middle) >= requiredTokenReduction) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return reductionAtBudget(low) >= requiredTokenReduction ? low : 1;
}
