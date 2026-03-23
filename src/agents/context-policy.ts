export const CONTEXT_WARNING_THRESHOLD = 80_000;
export const CONTEXT_COMPACT_THRESHOLD = 120_000;
export const CONTEXT_HARD_LIMIT = 180_000;

export const DEFAULT_SUMMARY_HISTORY_TAIL = 20;
export const MIN_SUMMARY_HISTORY_TAIL = 10;
export const MAX_SUMMARY_HISTORY_TAIL = 20;

export type ChatHistoryMode = "summary" | "full";

export type ContextPressureState = "ok" | "warning" | "compact" | "hard_limit";

export type ContextThresholdSnapshot = {
  warningThreshold: number;
  compactThreshold: number;
  hardLimit: number;
};

export type ContextUsageSnapshot = ContextThresholdSnapshot & {
  totalTokens: number | null;
  contextWindow: number | null;
  utilization: number | null;
  state: ContextPressureState;
  shouldWarn: boolean;
  shouldSuggestCompact: boolean;
  shouldAutoCompact: boolean;
};

export function getContextThresholds(): ContextThresholdSnapshot {
  return {
    warningThreshold: CONTEXT_WARNING_THRESHOLD,
    compactThreshold: CONTEXT_COMPACT_THRESHOLD,
    hardLimit: CONTEXT_HARD_LIMIT,
  };
}

export function normalizeChatHistoryMode(value: unknown): ChatHistoryMode {
  return value === "full" ? "full" : "summary";
}

export function normalizeSummaryHistoryTail(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SUMMARY_HISTORY_TAIL;
  }
  return Math.max(MIN_SUMMARY_HISTORY_TAIL, Math.min(MAX_SUMMARY_HISTORY_TAIL, Math.floor(value)));
}

export function resolveContextPressureState(totalTokens?: number | null): ContextPressureState {
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return "ok";
  }
  if (totalTokens >= CONTEXT_HARD_LIMIT) {
    return "hard_limit";
  }
  if (totalTokens >= CONTEXT_COMPACT_THRESHOLD) {
    return "compact";
  }
  if (totalTokens >= CONTEXT_WARNING_THRESHOLD) {
    return "warning";
  }
  return "ok";
}

export function buildContextUsageSnapshot(params: {
  totalTokens?: number | null;
  contextWindow?: number | null;
}): ContextUsageSnapshot {
  const totalTokens =
    typeof params.totalTokens === "number" &&
    Number.isFinite(params.totalTokens) &&
    params.totalTokens >= 0
      ? params.totalTokens
      : null;
  const contextWindow =
    typeof params.contextWindow === "number" &&
    Number.isFinite(params.contextWindow) &&
    params.contextWindow > 0
      ? params.contextWindow
      : null;
  const state = resolveContextPressureState(totalTokens);
  return {
    ...getContextThresholds(),
    totalTokens,
    contextWindow,
    utilization:
      totalTokens != null && contextWindow != null && contextWindow > 0
        ? Math.min(1, totalTokens / contextWindow)
        : null,
    state,
    shouldWarn: state === "warning" || state === "compact" || state === "hard_limit",
    shouldSuggestCompact: state === "compact" || state === "hard_limit",
    shouldAutoCompact: state === "hard_limit",
  };
}

export function shouldRunHardLimitPreflightCompact(params: {
  totalTokens?: number | null;
  contextWindow?: number | null;
}): boolean {
  return buildContextUsageSnapshot(params).shouldAutoCompact;
}
