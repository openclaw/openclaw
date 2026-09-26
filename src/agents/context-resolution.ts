import {
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaude1MContext,
} from "@openclaw/llm-core";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeConfiguredProviderCatalogModelId,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  createConfiguredProviderModelResolver,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  lookupCachedContextTokens,
  lookupCachedContextWindow,
  minPositiveContextTokens,
  providerContextTokenCacheKey,
} from "./context-cache.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";

type ConfigModelEntry = { id?: string; contextWindow?: number; contextTokens?: number };
type ProviderConfigEntry = {
  models?: ConfigModelEntry[];
};
export type ModelsConfig = {
  providers?: Record<string, ProviderConfigEntry | undefined>;
};

export type ContextTokenResolutionParams = {
  cfg?: OpenClawConfig;
  provider?: string;
  modelProvider?: string;
  model?: string;
  fallbackContextTokens?: number;
  modelContextWindow?: number;
  modelContextTokens?: number;
  allowAsyncLoad?: boolean;
  allowUnscopedModelLookup?: boolean;
};

export type ModelContextTokenProjection = {
  contextTokens: number | undefined;
  authoredContextTokens: number | undefined;
};

const normalizePositiveContextTokens = (value: number | undefined) =>
  typeof value === "number" && value > 0 ? value : undefined;

export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_000_000;
export const ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS = 1_000_000;
export const ANTHROPIC_FABLE_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_OPUS_5_CONTEXT_TOKENS = 1_000_000;
export const ANTHROPIC_SONNET_5_CONTEXT_TOKENS = 1_000_000;

function resolveProviderModelRef(params: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } | undefined {
  const modelRaw = params.model?.trim();
  if (!modelRaw) {
    return undefined;
  }
  const providerRaw = params.provider?.trim();
  if (providerRaw) {
    const provider = normalizeProviderId(providerRaw);
    return provider ? { provider, model: modelRaw } : undefined;
  }
  const slash = modelRaw.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(modelRaw.slice(0, slash));
  const model = modelRaw.slice(slash + 1).trim();
  return provider && model ? { provider, model } : undefined;
}

/** Preserve shipped self-prefixed context refs after exact configured-row selection. */
function resolveConfiguredProviderModel(
  cfg: OpenClawConfig | null | undefined,
  provider: string,
  model: string,
): ConfigModelEntry | undefined {
  const providerConfig = resolveMergedModelProviderConfig(cfg ?? undefined, provider);
  const bareModel = stripSelfProviderModelPrefix(provider, model);
  const findModel = createConfiguredProviderModelResolver(providerConfig, provider, (id) =>
    normalizeConfiguredProviderCatalogModelId(provider, id),
  );
  return findModel(model) ?? (bareModel === model ? undefined : findModel(bareModel));
}

function resolveConfiguredRuntimeModel(
  cfg: OpenClawConfig | null | undefined,
  provider: string,
  modelProvider: string | undefined,
  model: string,
): ConfigModelEntry | undefined {
  const explicitResult = resolveConfiguredProviderModel(cfg, provider, model);
  if (explicitResult) {
    return explicitResult;
  }
  const canonicalProvider = modelProvider?.trim();
  if (
    !canonicalProvider ||
    normalizeProviderId(canonicalProvider) === normalizeProviderId(provider)
  ) {
    return undefined;
  }
  return resolveConfiguredProviderModel(cfg, canonicalProvider, model);
}

/** Returns only the per-model contextTokens value authored in OpenClaw config. */
export function resolveAuthoredModelContextTokens(
  params: Pick<ContextTokenResolutionParams, "cfg" | "provider" | "modelProvider" | "model">,
): number | undefined {
  const ref = resolveProviderModelRef(params);
  const explicitProvider = params.provider?.trim();
  if (!ref || !explicitProvider) {
    return undefined;
  }
  return normalizePositiveContextTokens(
    resolveConfiguredRuntimeModel(params.cfg, explicitProvider, params.modelProvider, ref.model)
      ?.contextTokens,
  );
}

function resolveModelFamilyId(modelId: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.includes("/") ? (normalized.split("/").at(-1) ?? normalized) : normalized;
}

export function resolveAnthropicFixedContextWindow(
  provider: string,
  model: string,
  options?: { claudeCli1M?: boolean },
): number | undefined {
  const modelId = resolveModelFamilyId(model);
  const isAnthropicProvider =
    provider === "anthropic" || provider === "anthropic-vertex" || provider === "claude-cli";
  if (!isAnthropicProvider) {
    return undefined;
  }
  if (/^claude-fable-5(?=$|[^a-z0-9])/.test(modelId)) {
    return ANTHROPIC_FABLE_CONTEXT_TOKENS;
  }
  // Mythos 5 is direct-API only; Claude CLI must keep its discovered or fallback window.
  if (
    (provider === "anthropic" || provider === "anthropic-vertex") &&
    /^claude-mythos-5(?=$|[^a-z0-9])/.test(modelId)
  ) {
    return ANTHROPIC_MYTHOS_5_CONTEXT_TOKENS;
  }
  // Opus 5 is natively 1M on every runtime, including Claude CLI. Keep this
  // ahead of the legacy CLI opt-in gate used by older 1M variants below.
  if (resolveClaudeOpus5ModelIdentity({ id: modelId })) {
    return ANTHROPIC_OPUS_5_CONTEXT_TOKENS;
  }
  if (resolveClaudeSonnet5ModelIdentity({ id: modelId })) {
    return ANTHROPIC_SONNET_5_CONTEXT_TOKENS;
  }
  if (!supportsClaude1MContext({ id: modelId })) {
    return undefined;
  }
  if (provider === "claude-cli" && !modelId.endsWith("[1m]") && options?.claudeCli1M !== true) {
    return undefined;
  }
  return provider === "anthropic-vertex"
    ? ANTHROPIC_VERTEX_CONTEXT_1M_TOKENS
    : ANTHROPIC_CONTEXT_1M_TOKENS;
}

/** Resolves an authored cap without lowering it to discovered model metadata. */
export function resolveConfiguredContextTokenLimits(
  params: Pick<ContextTokenResolutionParams, "cfg" | "modelProvider"> & {
    provider: string;
    model: string;
  },
  // Guards require whole finite tokens; cache lookup retains its existing numeric projection.
  normalize: (
    value: number | undefined,
  ) => number | null | undefined = normalizePositiveContextTokens,
): {
  effectiveConfiguredTokens?: number;
  configuredContextWindow?: number;
  fixedContextWindow?: number;
} {
  const provider = params.provider.trim();
  const model = params.model.trim();
  const configuredModel = resolveConfiguredRuntimeModel(
    params.cfg,
    provider,
    params.modelProvider,
    model,
  );
  return resolveConfiguredContextTokenLimitsForModel(
    { cfg: params.cfg, provider, model },
    configuredModel,
    normalize,
  );
}

function resolveConfiguredContextTokenLimitsForModel(
  params: Pick<ContextTokenResolutionParams, "cfg"> & { provider: string; model: string },
  configuredModel: ConfigModelEntry | undefined,
  normalize: (value: number | undefined) => number | null | undefined,
) {
  const { provider, model } = params;
  const extraParamSources = resolveModelExtraParamSources({
    config: params.cfg,
    provider: normalizeProviderId(provider),
    modelId: model,
  });
  const effectiveContext1M =
    extraParamSources.modelParams && Object.hasOwn(extraParamSources.modelParams, "context1m")
      ? extraParamSources.modelParams.context1m
      : extraParamSources.defaultParams?.context1m;
  const fixedContextWindow = resolveAnthropicFixedContextWindow(
    normalizeProviderId(provider),
    model,
    { claudeCli1M: effectiveContext1M === true },
  );
  const configuredContextTokens = normalize(configuredModel?.contextTokens) ?? undefined;
  const configuredContextWindow = normalize(configuredModel?.contextWindow) ?? undefined;
  // Fixed provider contracts deliberately ignore materialized catalog windows.
  // Other runtimes must still keep an authored effective cap below its native window.
  const configuredTokenLimit = fixedContextWindow ?? configuredContextWindow;
  return {
    configuredContextWindow,
    fixedContextWindow,
    effectiveConfiguredTokens:
      configuredContextTokens === undefined
        ? undefined
        : configuredTokenLimit === undefined
          ? configuredContextTokens
          : Math.min(configuredContextTokens, configuredTokenLimit),
  };
}

export function resolveContextTokensForModelFromCache(
  params: ContextTokenResolutionParams,
  lookupContextTokens: (modelId?: string) => number | undefined = lookupCachedContextTokens,
  lookupContextWindow: (modelId?: string) => number | undefined = lookupCachedContextWindow,
): number | undefined {
  return resolveModelContextTokenProjectionFromCache(
    params,
    lookupContextTokens,
    lookupContextWindow,
  ).contextTokens;
}

export function resolveModelContextTokenProjectionFromCache(
  params: ContextTokenResolutionParams,
  lookupContextTokens: (modelId?: string) => number | undefined = lookupCachedContextTokens,
  lookupContextWindow: (modelId?: string) => number | undefined = lookupCachedContextWindow,
): ModelContextTokenProjection {
  const ref = resolveProviderModelRef(params);
  const explicitProvider = params.provider?.trim();
  let authoredContextTokens: number | undefined;

  if (ref && explicitProvider) {
    const configuredModel = resolveConfiguredRuntimeModel(
      params.cfg,
      explicitProvider,
      params.modelProvider,
      ref.model,
    );
    authoredContextTokens = normalizePositiveContextTokens(configuredModel?.contextTokens);
    const { effectiveConfiguredTokens, configuredContextWindow, fixedContextWindow } =
      resolveConfiguredContextTokenLimitsForModel(
        { cfg: params.cfg, provider: explicitProvider, model: ref.model },
        configuredModel,
        normalizePositiveContextTokens,
      );
    if (effectiveConfiguredTokens !== undefined) {
      return { contextTokens: effectiveConfiguredTokens, authoredContextTokens };
    }
    if (fixedContextWindow !== undefined) {
      return { contextTokens: fixedContextWindow, authoredContextTokens };
    }
    const providerResult = lookupContextTokens(
      providerContextTokenCacheKey(normalizeProviderId(ref.provider), ref.model),
    );
    const providerWindow = lookupContextWindow(
      providerContextTokenCacheKey(normalizeProviderId(ref.provider), ref.model),
    );
    const discoveredCap = minPositiveContextTokens(
      providerResult,
      normalizePositiveContextTokens(params.modelContextTokens),
      providerWindow,
      normalizePositiveContextTokens(params.modelContextWindow),
    );
    if (discoveredCap !== undefined) {
      return {
        contextTokens:
          configuredContextWindow === undefined
            ? discoveredCap
            : Math.min(discoveredCap, configuredContextWindow),
        authoredContextTokens,
      };
    }
    if (configuredContextWindow !== undefined) {
      return { contextTokens: configuredContextWindow, authoredContextTokens };
    }
  }

  if (params.allowUnscopedModelLookup === false) {
    return { contextTokens: params.fallbackContextTokens, authoredContextTokens };
  }

  // Model-only calls use the raw discovery key.
  const bareResult = lookupContextTokens(params.model);
  const bareWindow = lookupContextWindow(params.model);
  const bareCap = minPositiveContextTokens(bareResult, bareWindow);
  if (bareCap !== undefined) {
    return { contextTokens: bareCap, authoredContextTokens };
  }

  return { contextTokens: params.fallbackContextTokens, authoredContextTokens };
}
