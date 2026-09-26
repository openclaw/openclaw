import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredContextTokenLimits } from "./context-resolution.js";
import { isLocalProviderEndpoint } from "./provider-attribution.js";

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 4_000;
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 8_000;
const CONTEXT_WINDOW_HARD_MIN_RATIO = 0.1;
const CONTEXT_WINDOW_WARN_BELOW_RATIO = 0.2;

type ContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";

export type ContextWindowInfo = {
  tokens: number;
  referenceTokens?: number;
  source: ContextWindowSource;
};

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

/** Resolve the effective context window and source for one provider/model. */
export function resolveContextWindowInfo(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  modelContextTokens?: number;
  modelContextWindow?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const configured = resolveConfiguredContextTokenLimits(
    { cfg: params.cfg, provider: params.provider, model: params.modelId },
    normalizePositiveInt,
  );
  const fromModelsConfig =
    configured.effectiveConfiguredTokens ?? configured.configuredContextWindow;
  const fromModel =
    normalizePositiveInt(params.modelContextTokens) ??
    normalizePositiveInt(params.modelContextWindow);
  const defaultTokens =
    normalizePositiveInt(params.defaultTokens) ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS;
  return fromModelsConfig
    ? { tokens: fromModelsConfig, source: "modelsConfig" }
    : fromModel
      ? { tokens: fromModel, source: "model" }
      : { tokens: defaultTokens, source: "default" };
}

type ContextWindowGuardResult = ContextWindowInfo & {
  hardMinTokens: number;
  warnBelowTokens: number;
  shouldWarn: boolean;
  shouldBlock: boolean;
};

/** Derive warning/block floors from the resolved model context window. */
function resolveContextWindowGuardThresholds(contextWindowTokens: number) {
  const tokens = normalizePositiveInt(contextWindowTokens) ?? 0;
  return {
    hardMinTokens: Math.max(
      CONTEXT_WINDOW_HARD_MIN_TOKENS,
      Math.floor(tokens * CONTEXT_WINDOW_HARD_MIN_RATIO),
    ),
    warnBelowTokens: Math.max(
      CONTEXT_WINDOW_WARN_BELOW_TOKENS,
      Math.floor(tokens * CONTEXT_WINDOW_WARN_BELOW_RATIO),
    ),
  };
}

/** Format a non-blocking low-context warning message. */
export function formatContextWindowWarningMessage(params: {
  provider: string;
  modelId: string;
  guard: ContextWindowGuardResult;
  runtimeBaseUrl?: string | null;
}): string {
  const base = `low context window: ${params.provider}/${params.modelId} ctx=${params.guard.tokens} (warn<${params.guard.warnBelowTokens}) source=${params.guard.source}`;
  if (!isLocalProviderEndpoint(params.runtimeBaseUrl)) {
    return base;
  }
  if (params.guard.source === "modelsConfig") {
    return (
      `${base}; OpenClaw is using the configured model context limit for this model, ` +
      `so raise contextWindow/contextTokens if it is set too low`
    );
  }
  return (
    `${base}; local/self-hosted runs work best at ` +
    `${params.guard.warnBelowTokens}+ tokens and may show weaker tool use or more compaction until the server/model context limit is raised`
  );
}

/** Format a blocking context-window guard message. */
export function formatContextWindowBlockMessage(params: {
  guard: ContextWindowGuardResult;
  runtimeBaseUrl?: string | null;
}): string {
  const base =
    `Model context window too small (${params.guard.tokens} tokens; ` +
    `source=${params.guard.source}). Minimum is ${params.guard.hardMinTokens}.`;
  if (!isLocalProviderEndpoint(params.runtimeBaseUrl)) {
    return base;
  }
  if (params.guard.source === "modelsConfig") {
    return (
      `${base} OpenClaw is using the configured model context limit for this model. ` +
      `Raise contextWindow/contextTokens or choose a larger model.`
    );
  }
  return (
    `${base} This looks like a local model endpoint. ` +
    `Raise the server/model context limit or choose a larger model. ` +
    `OpenClaw local/self-hosted runs work best at ${params.guard.warnBelowTokens}+ tokens.`
  );
}

/** Evaluate whether the resolved context window should warn or block. */
export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const normalizedTokens = normalizePositiveInt(params.info.tokens);
  const tokens = normalizedTokens ?? 0;
  const referenceTokens = normalizePositiveInt(params.info.referenceTokens) ?? tokens;
  const resolvedThresholds = resolveContextWindowGuardThresholds(referenceTokens);
  const warnBelow = Math.max(
    1,
    Math.floor(params.warnBelowTokens ?? resolvedThresholds.warnBelowTokens),
  );
  const defaultHardMin = Math.min(
    resolvedThresholds.hardMinTokens,
    Math.max(tokens, CONTEXT_WINDOW_HARD_MIN_TOKENS),
  );
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? defaultHardMin));
  return {
    ...params.info,
    tokens,
    hardMinTokens: hardMin,
    warnBelowTokens: warnBelow,
    shouldWarn: !normalizedTokens || tokens < warnBelow,
    shouldBlock: !normalizedTokens || tokens < hardMin,
  };
}
