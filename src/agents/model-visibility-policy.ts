/**
 * Builds model visibility policies while retaining configured automatic fallbacks.
 */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  modelKey,
  normalizeProviderId,
  type ModelManifestNormalizationContext,
} from "./model-ref-shared.js";
import { isCliProvider } from "./model-selection-cli.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import {
  createModelVisibilityPolicyWithFallbacks,
  dedupeModelCatalogEntries,
  resolveConfiguredModelPrimaryValue,
  resolveConfiguredModelRef,
  type ModelVisibilityPolicy,
} from "./model-selection-shared.js";

export const RUNTIME_MODEL_VISIBILITY_NORMALIZATION = {
  allowManifestNormalization: true,
  allowPluginNormalization: true,
} as const;

function resolveAdditionalConfiguredModelRefs(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string[] {
  const defaults = params.cfg.agents?.defaults;
  const agent = params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  return [
    resolveAgentModelPrimaryValue(defaults?.model),
    ...resolveAgentModelFallbackValues(defaults?.model),
    resolveAgentModelPrimaryValue(agent?.model),
    ...resolveAgentModelFallbackValues(agent?.model),
    ...Object.keys(defaults?.models ?? {}),
    ...Object.keys(agent?.models ?? {}),
    agent?.utilityModel ?? defaults?.utilityModel,
    resolveAgentModelPrimaryValue(defaults?.imageModel),
    ...resolveAgentModelFallbackValues(defaults?.imageModel),
    resolveAgentModelPrimaryValue(defaults?.pdfModel),
    ...resolveAgentModelFallbackValues(defaults?.pdfModel),
  ].filter((ref): ref is string => typeof ref === "string");
}

export function createModelVisibilityPolicy(
  params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    modelCatalog?: ModelCatalogSnapshot;
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
    sessionKey?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelVisibilityPolicy {
  const policyParams = {
    cfg: params.cfg,
    catalog: params.catalog,
    modelCatalog: params.modelCatalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    fallbackModels: resolveConfiguredModelFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
    additionalConfiguredModelRefs: resolveAdditionalConfiguredModelRefs(params),
    // Model visibility is used by lightweight status/list paths. Keep plugin
    // manifest normalization opt-in so those paths do not load plugin runtime
    // metadata unless a caller explicitly needs it.
    allowManifestNormalization: params.allowManifestNormalization ?? false,
    allowPluginNormalization: params.allowPluginNormalization ?? false,
    manifestPlugins: params.manifestPlugins,
  };
  const policy = createModelVisibilityPolicyWithFallbacks(policyParams);
  return { ...policy, effectiveDefault: resolveEffectiveDefaultModel(policyParams, policy) };
}

export type { ModelVisibilityPolicy };

function resolveEffectiveDefaultModel(
  params: Parameters<typeof createModelVisibilityPolicy>[0],
  policy: Omit<ModelVisibilityPolicy, "effectiveDefault">,
): ModelVisibilityPolicy["effectiveDefault"] {
  const authoredPrimary = resolveConfiguredModelPrimaryValue(params);
  const primary = resolveConfiguredModelRef({
    ...params,
    defaultProvider: authoredPrimary ? DEFAULT_PROVIDER : params.defaultProvider,
    defaultModel: authoredPrimary ? DEFAULT_MODEL : (params.defaultModel ?? DEFAULT_MODEL),
  });
  const snapshot = params.modelCatalog;
  // Config-only readers cannot establish absence. A failed refresh cannot establish withdrawal.
  if (!authoredPrimary || !snapshot || snapshot.authoritative === false || snapshot.refreshFailed) {
    return {
      ref: policy.resolveSelection(primary),
    };
  }
  const catalog = dedupeModelCatalogEntries([...snapshot.entries, ...policy.configuredCatalog]);
  // A captured physical route can be omitted from the logical browse rows.
  const primaryEntry =
    findModelCatalogEntry(catalog, {
      provider: primary.provider,
      modelId: primary.model,
    }) ??
    findModelCatalogEntry(
      snapshot.routeVariants.filter((entry) => !entry.nativeRuntime),
      { provider: primary.provider, modelId: primary.model },
    );
  const { runtime } = resolveAgentHarnessPolicy({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    provider: primary.provider,
    modelId: primary.model,
    modelApi: primaryEntry?.api,
    modelBaseUrl: primaryEntry?.baseUrl,
  });
  const nativeRuntime =
    runtime !== "auto" && runtime !== "openclaw"
      ? runtime
      : isCliProvider(primary.provider, params.cfg)
        ? primary.provider
        : undefined;
  const nativeCatalog = nativeRuntime
    ? snapshot.entries.filter((entry) => entry.nativeRuntime === nativeRuntime)
    : [];
  // Host inventory cannot establish that a native runtime withdrew a model.
  if (nativeRuntime && nativeCatalog.length === 0) {
    return { ref: primary };
  }
  if (
    nativeRuntime
      ? findModelCatalogEntry(nativeCatalog, { provider: primary.provider, modelId: primary.model })
      : primaryEntry ||
        snapshot.resolvedConfiguredModelRefs?.some(
          (ref) => modelKey(ref.provider, ref.model) === modelKey(primary.provider, primary.model),
        )
  ) {
    return { ref: primary };
  }
  const preferred = resolveConfiguredProviderFallback({
    cfg: params.cfg,
    defaultProvider: primary.provider,
    defaultModel: primary.model,
  });
  const preferredEntry = preferred
    ? findModelCatalogEntry(catalog, { provider: preferred.provider, modelId: preferred.model })
    : undefined;
  const primaryKey = modelKey(primary.provider, primary.model);
  const replacement = [
    ...(preferredEntry ? [preferredEntry] : []),
    ...policy.configuredCatalog,
    ...catalog,
  ].find(
    (entry) =>
      modelKey(entry.provider, entry.id) !== primaryKey &&
      entry.status !== "deprecated" &&
      entry.status !== "disabled" &&
      (!nativeRuntime ||
        normalizeProviderId(entry.provider) !== normalizeProviderId(primary.provider) ||
        Boolean(
          findModelCatalogEntry(nativeCatalog, { provider: entry.provider, modelId: entry.id }),
        )) &&
      policy.allowsByList({ provider: entry.provider, model: entry.id }),
  );
  return {
    ref: replacement ? { provider: replacement.provider, model: replacement.id } : null,
    missingPrimary: primaryKey,
  };
}
