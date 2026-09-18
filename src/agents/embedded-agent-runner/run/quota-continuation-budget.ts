import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { observeAgentRunApprovalWait } from "../../agent-run-approval-wait.js";
import type { RunRetryBudget } from "./retry-budget.js";

/** Accounting only: existing attempt/queue owners retain all timers and cancellation. */
export function createQuotaContinuationBudget(identity: { runId?: string; sessionId?: string }) {
  const started = performance.now();
  const approvals = observeAgentRunApprovalWait(identity);
  const retries = new Set<RunRetryBudget>();
  let limit: number | undefined;
  let continuedRetries: RunRetryBudget | undefined;
  return {
    initialize(timeoutMs: number) {
      limit ??= timeoutMs;
    },
    remainingMs(cap = MAX_TIMER_TIMEOUT_MS) {
      if (limit === undefined || approvals.pending) {
        return 0;
      }
      const remaining =
        limit >= MAX_TIMER_TIMEOUT_MS
          ? MAX_TIMER_TIMEOUT_MS
          : limit - Math.max(0, performance.now() - started - approvals.pausedMs);
      return Math.max(0, Math.min(cap, remaining));
    },
    observeRetries(budget: RunRetryBudget) {
      retries.add(budget);
    },
    continueRetries(maxAttempts: number): RunRetryBudget {
      continuedRetries ??= {
        maxAttempts: Math.min(maxAttempts, ...[...retries].map((budget) => budget.maxAttempts)),
        attemptsCounted: [...retries].reduce((sum, budget) => sum + budget.attemptsCounted, 0),
        attemptsDispatched: [...retries].reduce(
          (sum, budget) => sum + budget.attemptsDispatched,
          0,
        ),
      };
      return continuedRetries;
    },
    dispose: () => approvals.dispose(),
  };
}

export type QuotaContinuationBudget = ReturnType<typeof createQuotaContinuationBudget>;
