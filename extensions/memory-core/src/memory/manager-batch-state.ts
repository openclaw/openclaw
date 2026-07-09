// Memory Core plugin module implements manager batch state behavior.
export const MEMORY_BATCH_FAILURE_LIMIT = 2;

type MemoryBatchFailureState = {
  enabled: boolean;
  count: number;
  lastError?: string;
  lastProvider?: string;
};

export function resetMemoryBatchFailureState(
  state: MemoryBatchFailureState,
): MemoryBatchFailureState {
  return {
    ...state,
    count: 0,
    lastError: undefined,
    lastProvider: undefined,
  };
}

function normalizeFailureAttempts(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function recordMemoryBatchFailure(
  state: MemoryBatchFailureState,
  params: {
    provider: string;
    message: string;
    attempts?: number;
    forceDisable?: boolean;
  },
): MemoryBatchFailureState {
  if (!state.enabled) {
    return state;
  }
  const increment = params.forceDisable
    ? MEMORY_BATCH_FAILURE_LIMIT
    : normalizeFailureAttempts(params.attempts);
  const count = state.count + increment;
  const enabled = !(params.forceDisable || count >= MEMORY_BATCH_FAILURE_LIMIT);
  return {
    enabled,
    count,
    lastError: params.message,
    lastProvider: params.provider,
  };
}
