/**
 * Process-global counters for subagent announce delivery observability.
 *
 * Surfaced via `AcpSessionManager.getObservabilitySnapshot` so `/acp doctor`
 * shows retry/timeout/budget-exhaustion rates for the announce path.
 */

export type SubagentAnnounceCounters = {
  retriesTotal: number;
  timeoutsTotal: number;
  budgetExhaustedTotal: number;
  lastTimeoutAt?: number;
};

const state: SubagentAnnounceCounters = {
  retriesTotal: 0,
  timeoutsTotal: 0,
  budgetExhaustedTotal: 0,
};

export function recordAnnounceRetry(): void {
  state.retriesTotal += 1;
}

export function recordAnnounceTimeout(at: number = Date.now()): void {
  state.timeoutsTotal += 1;
  state.lastTimeoutAt = at;
}

export function recordAnnounceBudgetExhausted(): void {
  state.budgetExhaustedTotal += 1;
}

export function getSubagentAnnounceCounters(): SubagentAnnounceCounters {
  // Return a shallow copy so callers cannot mutate the source.
  const snapshot: SubagentAnnounceCounters = {
    retriesTotal: state.retriesTotal,
    timeoutsTotal: state.timeoutsTotal,
    budgetExhaustedTotal: state.budgetExhaustedTotal,
  };
  if (state.lastTimeoutAt !== undefined) {
    snapshot.lastTimeoutAt = state.lastTimeoutAt;
  }
  return snapshot;
}

export function resetSubagentAnnounceCountersForTest(): void {
  state.retriesTotal = 0;
  state.timeoutsTotal = 0;
  state.budgetExhaustedTotal = 0;
  state.lastTimeoutAt = undefined;
}
