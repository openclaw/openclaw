import type { OpenClawConfig } from "../config/config.js";

/**
 * Hard minimum context window size in tokens.
 * Below this threshold, operations may be blocked to prevent failures.
 * 16K tokens is a reasonable minimum for most modern LLM operations.
 */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;

/**
 * Warning threshold for context window size.
 * Operations proceeding with less than this amount will trigger warnings.
 * 32K tokens provides comfortable headroom for most use cases.
 */
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

/**
 * Safety margin multiplier for token estimation.
 * Accounts for estimation inaccuracies and tokenizer differences.
 */
export const TOKEN_ESTIMATE_SAFETY_MARGIN = 1.15; // 15% buffer

/**
 * Minimum recommended free tokens as ratio of total context.
 * Having less than 20% free space risks hitting limits during generation.
 */
export const MIN_FREE_SPACE_RATIO = 0.2;

/**
 * Source of the context window value, used for debugging and telemetry.
 */
export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

/**
 * Information about the resolved context window.
 */
export type ContextWindowInfo = {
  /** Resolved context window size in tokens */
  tokens: number;
  /** Where this value came from (for debugging) */
  source: ContextWindowSource;
  /** Timestamp when resolved (for cache invalidation) */
  resolvedAt?: number;
};

/**
 * Normalizes a value to a positive integer, returning null for invalid inputs.
 * Handles NaN, Infinity, negative values, and non-numeric types.
 *
 * @param value - The value to normalize
 * @returns Positive integer or null if invalid
 */
function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 && int < Number.MAX_SAFE_INTEGER ? int : null;
}

/**
 * Estimates the actual token count from character count with safety margin.
 * Different models use different tokenizers, so this provides a conservative estimate.
 *
 * @param charCount - Number of characters
 * @returns Estimated token count with safety margin
 */
export function estimateTokensFromChars(charCount: number): number {
  const safeCharCount = normalizePositiveInt(charCount) ?? 0;
  // Average: ~4 chars per token, but varies by language and content
  const baseEstimate = Math.ceil(safeCharCount / 4);
  return Math.ceil(baseEstimate * TOKEN_ESTIMATE_SAFETY_MARGIN);
}

/**
 * Calculates a safe maximum input size given a context window.
 * Reserves space for model output (typically 20-40% of context).
 *
 * @param contextWindow - Total context window in tokens
 * @param outputReserveRatio - Ratio to reserve for output (default: 0.3)
 * @returns Safe maximum input tokens
 */
export function calculateSafeInputSize(contextWindow: number, outputReserveRatio = 0.3): number {
  const safeWindow = normalizePositiveInt(contextWindow) ?? 8192;
  const safeReserve = Math.max(0, Math.min(0.5, outputReserveRatio));
  return Math.floor(safeWindow * (1 - safeReserve));
}

/**
 * Calculates the urgency level based on available context space.
 * Used to determine warning severity and potential actions.
 *
 * @param usedTokens - Currently used tokens
 * @param totalTokens - Total context window
 * @returns Urgency level: 'ok' | 'notice' | 'warning' | 'critical'
 */
export function calculateSpaceUrgency(
  usedTokens: number,
  totalTokens: number,
): "ok" | "notice" | "warning" | "critical" {
  const safeUsed = Math.max(0, normalizePositiveInt(usedTokens) ?? 0);
  const safeTotal = Math.max(1, normalizePositiveInt(totalTokens) ?? 8192);
  const usedRatio = safeUsed / safeTotal;

  if (usedRatio < 0.5) {
    return "ok";
  }
  if (usedRatio < 0.7) {
    return "notice";
  }
  if (usedRatio < 0.85) {
    return "warning";
  }
  return "critical";
}

/**
 * Resolves the effective context window size from multiple sources.
 * Resolution priority (highest to lowest):
 * 1. modelsConfig - Provider-specific model configuration
 * 2. model - Runtime model metadata
 * 3. default - System default
 *
 * After resolution, applies agent context token cap if configured and lower.
 *
 * @param params - Resolution parameters
 * @returns ContextWindowInfo with tokens and source
 */
export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  // Extract from models config if available
  const fromModelsConfig = (() => {
    try {
      const providers = params.cfg?.models?.providers as
        | Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>
        | undefined;
      const providerEntry = providers?.[params.provider];
      const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
      const match = models.find((m) => m?.id === params.modelId);
      return normalizePositiveInt(match?.contextWindow);
    } catch (error) {
      // Config access errors should not break resolution
      console.warn("Error reading models config:", error);
      return null;
    }
  })();

  const fromModel = normalizePositiveInt(params.modelContextWindow);

  // Determine base info using priority order
  const baseInfo: ContextWindowInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" as const }
    : fromModel
      ? { tokens: fromModel, source: "model" as const }
      : {
          tokens: Math.max(1, Math.floor(normalizePositiveInt(params.defaultTokens) ?? 8192)),
          source: "default" as const,
        };

  // Apply agent context token cap if configured and lower than base
  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return {
      tokens: capTokens,
      source: "agentContextTokens",
      resolvedAt: Date.now(),
    };
  }

  return {
    ...baseInfo,
    resolvedAt: Date.now(),
  };
}

/**
 * Result of evaluating context window guard conditions.
 * Includes intelligent warnings and recommendations.
 */
export type ContextWindowGuardResult = ContextWindowInfo & {
  /** Whether a warning should be shown to the user */
  shouldWarn: boolean;
  /** Whether operations should be blocked due to insufficient context */
  shouldBlock: boolean;
  /** Urgency level based on available space */
  urgencyLevel: "ok" | "notice" | "warning" | "critical";
  /** Recommended maximum input tokens for safe operation */
  recommendedMaxInput: number;
  /** Recommended minimum free space to maintain */
  recommendedFreeSpace: number;
  /** Human-readable recommendation message */
  recommendation: string;
};

/**
 * Evaluates context window constraints and returns guard result with recommendations.
 * Provides intelligent warnings based on the configured thresholds.
 *
 * @param params - Evaluation parameters
 * @returns ContextWindowGuardResult with warnings and recommendations
 */
export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
  usedTokens?: number;
}): ContextWindowGuardResult {
  // Validate and normalize thresholds
  const warnBelow = Math.max(
    1,
    Math.floor(normalizePositiveInt(params.warnBelowTokens) ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(
    1,
    Math.floor(normalizePositiveInt(params.hardMinTokens) ?? CONTEXT_WINDOW_HARD_MIN_TOKENS),
  );

  // Ensure tokens are valid
  const tokens = Math.max(0, Math.floor(normalizePositiveInt(params.info.tokens) ?? 0));
  const usedTokens = Math.max(0, normalizePositiveInt(params.usedTokens) ?? 0);

  // Calculate urgency based on available space
  const urgencyLevel = calculateSpaceUrgency(usedTokens, tokens);

  // Determine warnings and blocks
  const shouldWarn = tokens > 0 && tokens < warnBelow;
  const shouldBlock = tokens > 0 && tokens < hardMin;

  // Calculate recommendations
  const recommendedMaxInput = calculateSafeInputSize(tokens);
  const recommendedFreeSpace = Math.floor(tokens * MIN_FREE_SPACE_RATIO);

  // Generate human-readable recommendation
  const recommendation = generateRecommendation({
    tokens,
    usedTokens,
    shouldBlock,
    shouldWarn,
    urgencyLevel,
    recommendedMaxInput,
    recommendedFreeSpace,
  });

  return {
    ...params.info,
    tokens,
    shouldWarn,
    shouldBlock,
    urgencyLevel,
    recommendedMaxInput,
    recommendedFreeSpace,
    recommendation,
  };
}

/**
 * Generates a human-readable recommendation message based on context window status.
 */
function generateRecommendation(params: {
  tokens: number;
  usedTokens: number;
  shouldBlock: boolean;
  shouldWarn: boolean;
  urgencyLevel: string;
  recommendedMaxInput: number;
  recommendedFreeSpace: number;
}): string {
  if (params.shouldBlock) {
    return (
      `Context window (${params.tokens.toLocaleString()} tokens) is below minimum ` +
      `(${CONTEXT_WINDOW_HARD_MIN_TOKENS.toLocaleString()} tokens). ` +
      `Operation blocked. Consider using a model with larger context window.`
    );
  }

  if (params.urgencyLevel === "critical") {
    return (
      `Context nearly full (${params.usedTokens.toLocaleString()}/${params.tokens.toLocaleString()} tokens). ` +
      `Immediate action recommended: compact history or use larger context model.`
    );
  }

  if (params.shouldWarn) {
    return (
      `Context window (${params.tokens.toLocaleString()} tokens) is limited. ` +
      `Recommended max input: ${params.recommendedMaxInput.toLocaleString()} tokens. ` +
      `Maintain at least ${params.recommendedFreeSpace.toLocaleString()} tokens free.`
    );
  }

  if (params.urgencyLevel === "notice") {
    return (
      `Context usage at ${Math.round((params.usedTokens / params.tokens) * 100)}%. ` +
      `Consider monitoring as conversation grows.`
    );
  }

  return `Context window healthy (${params.tokens.toLocaleString()} tokens available).`;
}
