import type { OpenClawConfig } from "../config/config.js";

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;
};

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

/** 1M context window token count, used when context1m beta param is active. */
const ANTHROPIC_CONTEXT_1M_TOKENS = 1_000_000;

/** Model IDs that support the anthropic context-1m-2025-08-07 beta.
 * Matches all Claude Opus/Sonnet 4.x models, consistent with
 * ANTHROPIC_1M_MODEL_PREFIXES in extra-params.ts. */
function isAnthropic1MCapableModel(provider: string, modelId: string): boolean {
  const p = provider.toLowerCase();
  if (p !== "anthropic" && p !== "antigravity" && !p.startsWith("google-antigravity")) {
    return false;
  }
  const id = modelId.toLowerCase().replace(/\./g, "-");
  return id.startsWith("claude-opus-4") || id.startsWith("claude-sonnet-4");
}

export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const fromModelsConfig = (() => {
    const providers = params.cfg?.models?.providers as
      | Record<string, { models?: Array<{ id?: string; contextWindow?: number }> }>
      | undefined;
    const providerEntry = providers?.[params.provider];
    const models = Array.isArray(providerEntry?.models) ? providerEntry.models : [];
    const match = models.find((m) => m?.id === params.modelId);
    return normalizePositiveInt(match?.contextWindow);
  })();
  const fromModel = normalizePositiveInt(params.modelContextWindow);
  const baseInfo = fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" as const }
    : fromModel
      ? { tokens: fromModel, source: "model" as const }
      : { tokens: Math.floor(params.defaultTokens), source: "default" as const };

  // When context1m: true is set in agents.defaults.models[key].params and no
  // explicit contextWindow override exists in models.providers, bump to 1M so the
  // TUI token gauge reflects the actual API context limit (#20500).
  // Note: mutate baseInfo.tokens so the contextTokens cap below is still applied.
  if (
    baseInfo.source !== "modelsConfig" &&
    isAnthropic1MCapableModel(params.provider, params.modelId)
  ) {
    const modelKey = `${params.provider}/${params.modelId}`;
    const agentModels = params.cfg?.agents?.defaults?.models as
      | Record<string, { params?: Record<string, unknown> }>
      | undefined;
    if (agentModels?.[modelKey]?.params?.context1m === true) {
      baseInfo.tokens = ANTHROPIC_CONTEXT_1M_TOKENS;
    }
  }

  const capTokens = normalizePositiveInt(params.cfg?.agents?.defaults?.contextTokens);
  if (capTokens && capTokens < baseInfo.tokens) {
    return { tokens: capTokens, source: "agentContextTokens" };
  }

  return baseInfo;
}

export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
};

export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));
  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };
}
