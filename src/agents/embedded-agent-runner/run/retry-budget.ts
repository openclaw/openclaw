export type RunRetryKind = "progress_continuation" | "recovery";

type RunRetryBudget = {
  attemptsDispatched: number;
  attemptsCounted: number;
  maxAttempts: number;
};

export function createRunRetryBudget(maxAttempts: number): RunRetryBudget {
  return { attemptsDispatched: 0, attemptsCounted: 0, maxAttempts };
}

export function isRunRetryBudgetExhausted(budget: RunRetryBudget): boolean {
  // attemptsDispatched is incremented on every beginRunAttempt and never
  // refunded, so it is the hard wall on billed model calls. attemptsCounted
  // stays diagnostic-only: progress_continuation refunds it, which would
  // otherwise let a no-op recovery route loop forever (#119313).
  return budget.attemptsDispatched >= budget.maxAttempts;
}

export function beginRunAttempt(budget: RunRetryBudget): void {
  budget.attemptsDispatched += 1;
  budget.attemptsCounted += 1;
}

export function resolveRunRetryKind(params: {
  preflightRecovery: { route: string; truncatedCount?: number };
  retryingFromTranscript: boolean;
  toolMetas: Array<{ isError?: boolean; meta?: string; toolName: string }>;
}): RunRetryKind {
  return params.retryingFromTranscript &&
    params.preflightRecovery.route === "truncate_tool_results_only" &&
    params.preflightRecovery.truncatedCount === 0 &&
    params.toolMetas.some((tool) => tool.isError !== true)
    ? "progress_continuation"
    : "recovery";
}

export function recordRunRetry(budget: RunRetryBudget, kind: RunRetryKind): void {
  if (kind === "progress_continuation") {
    budget.attemptsCounted = Math.max(0, budget.attemptsCounted - 1);
  }
}
