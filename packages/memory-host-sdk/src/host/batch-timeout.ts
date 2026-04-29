export type EmbeddingBatchTimeoutBudget = {
  timeoutMs: number;
  remainingMs: () => number;
};

export function createEmbeddingBatchTimeoutBudget(params: {
  timeoutMs: number;
  now?: () => number;
}): EmbeddingBatchTimeoutBudget {
  const now = params.now ?? Date.now;
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  const expiresAtMs = now() + timeoutMs;
  return {
    timeoutMs,
    remainingMs: () => Math.max(0, Math.floor(expiresAtMs - now())),
  };
}

export function resolveEmbeddingBatchTimeoutMs(params: {
  budget: EmbeddingBatchTimeoutBudget;
  timeoutMessage: string;
}): number {
  const remainingMs = params.budget.remainingMs();
  if (remainingMs <= 0) {
    throw new Error(params.timeoutMessage);
  }
  return remainingMs;
}

export function resolveEmbeddingBatchPollSleepMs(params: {
  budget: EmbeddingBatchTimeoutBudget;
  pollIntervalMs: number;
  timeoutMessage: string;
}): number {
  const remainingMs = resolveEmbeddingBatchTimeoutMs({
    budget: params.budget,
    timeoutMessage: params.timeoutMessage,
  });
  return Math.min(Math.max(0, Math.floor(params.pollIntervalMs)), remainingMs);
}
