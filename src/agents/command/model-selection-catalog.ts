import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  hasSessionActiveAutoModelFallback,
  hasSessionAutoModelSelection,
  resolveSessionModelOverrideRouteResolution,
} from "../../config/sessions/model-override-provenance.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  isModelSelectionLocked,
  repairProviderWrappedModelOverride,
} from "../../sessions/model-overrides.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { loadManifestModelCatalog } from "../model-catalog.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../model-visibility-policy.js";
import { hasResolvedThinkingCatalogEntry } from "../thinking-runtime.js";

function resolveSelectionCatalogDemand(params: {
  cfg: OpenClawConfig;
  agentId: string;
  defaultProvider: string;
  defaultModel: string;
  sessionEntry: SessionEntry | undefined;
  hasExplicitRunOverride: boolean;
  visibilityPolicy: ModelVisibilityPolicy;
  metadataSnapshot: PluginMetadataSnapshot | undefined;
}): "none" | "required" | "deferred" {
  const agentModels = resolveAgentConfig(params.cfg, params.agentId)?.models;
  const hasConfiguredModels =
    Object.keys(params.cfg.agents?.defaults?.models ?? {}).length > 0 ||
    Object.keys(agentModels ?? {}).length > 0;
  if (params.visibilityPolicy.allowAny && !hasConfiguredModels) {
    return "none";
  }
  const entry = params.sessionEntry;
  if (
    !entry ||
    params.hasExplicitRunOverride ||
    !params.metadataSnapshot ||
    params.visibilityPolicy.hasProviderWildcards ||
    params.visibilityPolicy.exactModelRefs.some((ref) => parseProviderModelRef(ref) === null) ||
    entry.modelOverrideSource !== "auto" ||
    !hasSessionAutoModelSelection(entry) ||
    hasSessionActiveAutoModelFallback(entry) ||
    resolveSessionModelOverrideRouteResolution(entry) !== "resolved"
  ) {
    return "required";
  }
  const provider = entry.providerOverride?.trim();
  const model = entry.modelOverride?.trim();
  if (
    !provider ||
    !model ||
    provider.includes("/") ||
    model.includes("/") ||
    !hasResolvedThinkingCatalogEntry({
      catalog: params.visibilityPolicy.configuredCatalog,
      provider,
      model,
    })
  ) {
    return "required";
  }
  // Canonical repair can replace the route that justified deferral.
  if (
    !isModelSelectionLocked(entry) &&
    repairProviderWrappedModelOverride({
      entry: { ...entry },
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
    }).updated
  ) {
    return "required";
  }
  // A catalog owner could add donor facts or make the stored route cataloged.
  const normalizedProvider = normalizeProviderId(provider);
  return [...params.metadataSnapshot.owners.modelCatalogProviders.keys()].some(
    (catalogProvider) => normalizeProviderId(catalogProvider) === normalizedProvider,
  )
    ? "required"
    : "deferred";
}

export function prepareCommandModelCatalog(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionEntry: SessionEntry | undefined;
  hasExplicitRunOverride: boolean;
  metadataSnapshot: PluginMetadataSnapshot | undefined;
  pluginsEnabled: boolean;
  workspaceDir: string;
  defaultProvider: string;
  defaultModel: string;
  modelManifestContext: ModelManifestNormalizationContext;
}) {
  const { cfg, metadataSnapshot, pluginsEnabled, workspaceDir } = params;
  const policyParams = {
    cfg,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: pluginsEnabled,
    ...params.modelManifestContext,
  };
  const configuredPolicy = createModelVisibilityPolicy({ ...policyParams, catalog: [] });
  let fullCatalog:
    | {
        catalog: ReturnType<typeof loadManifestModelCatalog>;
        policy: ModelVisibilityPolicy;
      }
    | undefined;
  const loadFullCatalog = () => {
    if (!fullCatalog) {
      const catalog = pluginsEnabled
        ? loadManifestModelCatalog({ config: cfg, workspaceDir, metadataSnapshot })
        : [];
      fullCatalog = {
        catalog,
        policy: createModelVisibilityPolicy({ ...policyParams, catalog }),
      };
    }
    return fullCatalog;
  };
  const demand = resolveSelectionCatalogDemand({
    ...params,
    visibilityPolicy: configuredPolicy,
  });
  const loaded = demand === "required" ? loadFullCatalog() : undefined;
  return {
    visibilityPolicy: loaded?.policy ?? configuredPolicy,
    modelCatalog: loaded?.catalog ?? null,
    allowedModelCatalog: loaded?.policy.allowedCatalog ?? [],
    ...(demand === "deferred"
      ? { loadDeferredThinkingCatalog: () => loadFullCatalog().policy.catalog }
      : {}),
  };
}
