/**
 * Context window guard.
 * Extracted from OpenClaw src/agents/context-window-guard.ts
 *
 * Resolves the effective context window size for a model
 * and evaluates whether it's dangerously small.
 */

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export type ContextWindowSource = "model" | "config" | "default";

export interface ContextWindowInfo {
  tokens: number;
  source: ContextWindowSource;
}

export interface ContextWindowGuardResult extends ContextWindowInfo {
  shouldWarn: boolean;
  shouldBlock: boolean;
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

/**
 * Resolve the effective context window for a model.
 * Priority: config override > model metadata > default.
 */
export function resolveContextWindowInfo(params: {
  configContextWindow?: number;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const fromConfig = normalizePositiveInt(params.configContextWindow);
  const fromModel = normalizePositiveInt(params.modelContextWindow);

  if (fromConfig) {
    return { tokens: fromConfig, source: "config" };
  }
  if (fromModel) {
    return { tokens: fromModel, source: "model" };
  }
  return { tokens: Math.floor(params.defaultTokens), source: "default" };
}

/**
 * Check if the resolved context window is dangerously small.
 */
export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(
    1,
    Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS),
  );
  const tokens = Math.max(0, Math.floor(params.info.tokens));

  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };
}
