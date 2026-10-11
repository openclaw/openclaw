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
import type { SessionContextTokenLimits } from "../config/sessions/context-token-provenance.js";
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
  modelContextWindowSource?: "synthetic";
  modelContextTokens?: number;
  nativeRuntime?: string;
  allowAsyncLoad?: boolean;
  allowUnscopedModelLookup?: boolean;
};

export type ModelContextTokenProjection = {
  contextTokens: number | undefined;
  configuredContextTokenLimits: SessionContextTokenLimits | undefined;
  source: "model" | "configured" | "fallback";
  contextTokensSource?: "synthetic" | "resolved";
};

const normalizePositiveContextTokens = (value: number | undefined) =>
  typeof value === "number" && value > 0 ? value : undefined;

const ANTHROPIC_CONTEXT_1M_TOKENS = 1_000_000;

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
  // Native 1M models precede the older CLI opt-in gate; Mythos remains direct-API only.
  if (
    /^claude-fable-5(?=$|[^a-z0-9])/.test(modelId) ||
    (provider !== "claude-cli" && /^claude-mythos-5(?=$|[^a-z0-9])/.test(modelId)) ||
    resolveClaudeOpus5ModelIdentity({ id: modelId }) ||
    resolveClaudeSonnet5ModelIdentity({ id: modelId })
  ) {
    return ANTHROPIC_CONTEXT_1M_TOKENS;
  }
  if (!supportsClaude1MContext({ id: modelId })) {
    return undefined;
  }
  if (provider === "claude-cli" && !modelId.endsWith("[1m]") && options?.claudeCli1M !== true) {
    return undefined;
  }
  return ANTHROPIC_CONTEXT_1M_TOKENS;
}

/** Resolves explicit configured inputs separately from their effective context limits. */
export function resolveConfiguredContextTokenLimits(
  params: Pick<
    ContextTokenResolutionParams,
    | "cfg"
    | "provider"
    | "model"
    | "modelProvider"
    | "modelContextWindow"
    | "modelContextWindowSource"
    | "nativeRuntime"
  >,
  // Guards require whole finite tokens; cache lookup retains its existing numeric projection.
  normalize: (
    value: number | undefined,
  ) => number | null | undefined = normalizePositiveContextTokens,
): {
  effectiveConfiguredTokens?: number;
  configuredContextTokens?: number;
  authoredContextTokenCap?: number;
  configuredContextWindow?: number;
  fixedContextWindow?: number;
} {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return {};
  }
  const configuredModel = resolveConfiguredRuntimeModel(
    params.cfg,
    provider,
    params.modelProvider,
    model,
  );
  return resolveConfiguredContextTokenLimitsForModel(
    { ...params, provider, model },
    configuredModel,
    normalize,
  );
}

function resolveConfiguredContextTokenLimitsForModel(
  params: Pick<
    ContextTokenResolutionParams,
    "cfg" | "modelContextWindow" | "modelContextWindowSource" | "nativeRuntime"
  > & { provider: string; model: string },
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
  const nativeRuntime = normalizeLowercaseStringOrEmpty(params.nativeRuntime);
  const fixedContractProvider =
    nativeRuntime && nativeRuntime !== "openclaw" ? nativeRuntime : normalizeProviderId(provider);
  const fixedContextWindow = resolveAnthropicFixedContextWindow(fixedContractProvider, model, {
    claudeCli1M: effectiveContext1M === true,
  });
  const configuredContextTokens = normalize(configuredModel?.contextTokens) ?? undefined;
  const configuredContextWindow = normalize(configuredModel?.contextWindow) ?? undefined;
  // Fixed provider contracts deliberately ignore materialized catalog windows.
  // Other runtimes must still keep an authored effective cap below its native window.
  const nativeContextWindow =
    params.modelContextWindowSource === "synthetic"
      ? undefined
      : (normalize(params.modelContextWindow) ?? undefined);
  const configuredTokenLimit =
    fixedContextWindow ?? minPositiveContextTokens(configuredContextWindow, nativeContextWindow);
  const effectiveConfiguredTokens =
    configuredContextTokens === undefined
      ? undefined
      : configuredTokenLimit === undefined
        ? configuredContextTokens
        : Math.min(configuredContextTokens, configuredTokenLimit);
  return {
    configuredContextWindow,
    configuredContextTokens,
    fixedContextWindow,
    effectiveConfiguredTokens,
    authoredContextTokenCap:
      effectiveConfiguredTokens ??
      (fixedContextWindow === undefined ? configuredContextWindow : undefined),
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
  const nativeRuntime = normalizeLowercaseStringOrEmpty(params.nativeRuntime);
  const useApiCapacity = !nativeRuntime || nativeRuntime === "openclaw";
  const ref = resolveProviderModelRef(params);
  const explicitProvider = params.provider?.trim();
  let configuredContextTokenLimits: SessionContextTokenLimits | undefined;

  if (ref && explicitProvider) {
    const configuredModel = resolveConfiguredRuntimeModel(
      params.cfg,
      explicitProvider,
      params.modelProvider,
      ref.model,
    );
    const configuredLimits = resolveConfiguredContextTokenLimitsForModel(
      { ...params, provider: explicitProvider, model: ref.model },
      configuredModel,
      normalizePositiveContextTokens,
    );
    configuredContextTokenLimits = configuredLimits;
    const { effectiveConfiguredTokens, configuredContextWindow, fixedContextWindow } =
      configuredLimits;
    if (effectiveConfiguredTokens !== undefined) {
      return {
        contextTokens: effectiveConfiguredTokens,
        configuredContextTokenLimits,
        source: "configured",
      };
    }
    if (fixedContextWindow !== undefined) {
      return {
        contextTokens: minPositiveContextTokens(
          fixedContextWindow,
          normalizePositiveContextTokens(params.modelContextTokens),
        ),
        configuredContextTokenLimits,
        source: "model",
      };
    }
    const providerResult = useApiCapacity
      ? lookupContextTokens(
          providerContextTokenCacheKey(normalizeProviderId(ref.provider), ref.model),
        )
      : undefined;
    const providerWindow = useApiCapacity
      ? lookupContextWindow(
          providerContextTokenCacheKey(normalizeProviderId(ref.provider), ref.model),
        )
      : undefined;
    const discoveredCap = minPositiveContextTokens(
      providerResult,
      normalizePositiveContextTokens(params.modelContextTokens),
      providerWindow,
      params.modelContextWindowSource === "synthetic"
        ? undefined
        : normalizePositiveContextTokens(params.modelContextWindow),
    );
    if (discoveredCap !== undefined) {
      return {
        contextTokens:
          configuredContextWindow === undefined
            ? discoveredCap
            : Math.min(discoveredCap, configuredContextWindow),
        configuredContextTokenLimits,
        source:
          configuredContextWindow !== undefined && configuredContextWindow <= discoveredCap
            ? "configured"
            : "model",
      };
    }
    if (configuredContextWindow !== undefined) {
      return {
        contextTokens: configuredContextWindow,
        configuredContextTokenLimits,
        source: "configured",
      };
    }
  }

  const syntheticWindow =
    params.modelContextWindowSource === "synthetic"
      ? normalizePositiveContextTokens(params.modelContextWindow)
      : undefined;
  const fallbackContextTokens = syntheticWindow ?? params.fallbackContextTokens;
  const contextTokensSource = syntheticWindow === undefined ? undefined : "synthetic";
  if (!useApiCapacity || params.allowUnscopedModelLookup === false) {
    return {
      contextTokens: fallbackContextTokens,
      configuredContextTokenLimits,
      source: "fallback",
      ...(contextTokensSource ? { contextTokensSource } : {}),
    };
  }

  // Model-only calls use the raw discovery key.
  const bareResult = lookupContextTokens(params.model);
  const bareWindow = lookupContextWindow(params.model);
  const bareCap = minPositiveContextTokens(bareResult, bareWindow);
  return {
    contextTokens: bareCap ?? fallbackContextTokens,
    configuredContextTokenLimits,
    source: bareCap === undefined ? "fallback" : "model",
    ...(bareCap === undefined && contextTokensSource ? { contextTokensSource } : {}),
  };
}
