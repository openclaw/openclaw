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
import { loadManifestModelCatalog } from "../model-catalog.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../model-visibility-policy.js";
import { hasResolvedThinkingCatalogEntry } from "../thinking-runtime.js";

function resolveDeferredSelection(params: {
  defaultProvider: string;
  defaultModel: string;
  sessionEntry: SessionEntry | undefined;
  hasExplicitRunOverride: boolean;
  pluginsEnabled: boolean;
  metadataSnapshot: PluginMetadataSnapshot | undefined;
}) {
  const entry = params.sessionEntry;
  if (
    !params.pluginsEnabled ||
    !entry ||
    params.hasExplicitRunOverride ||
    !params.metadataSnapshot ||
    entry.modelOverrideSource !== "auto" ||
    !hasSessionAutoModelSelection(entry) ||
    hasSessionActiveAutoModelFallback(entry) ||
    resolveSessionModelOverrideRouteResolution(entry) !== "resolved"
  ) {
    return undefined;
  }
  const provider = entry.providerOverride?.trim();
  const model = entry.modelOverride?.trim();
  if (!provider || !model || provider.includes("/") || model.includes("/")) {
    return undefined;
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
    return undefined;
  }
  // A catalog owner could add donor facts or make the stored route cataloged.
  const normalizedProvider = normalizeProviderId(provider);
  return [...params.metadataSnapshot.owners.modelCatalogProviders.keys()].some(
    (catalogProvider) => normalizeProviderId(catalogProvider) === normalizedProvider,
  )
    ? undefined
    : { provider, model };
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
    defaultModel: { provider: params.defaultProvider, model: params.defaultModel },
    agentId: params.agentId,
    allowManifestNormalization: true,
    allowPluginNormalization: pluginsEnabled,
    ...params.modelManifestContext,
  };
  let fullCatalog:
    | {
        catalog: ReturnType<typeof loadManifestModelCatalog>;
        policy: ModelVisibilityPolicy;
      }
    | undefined;
  const loadFullCatalog = () => {
    if (!fullCatalog) {
      const catalog = pluginsEnabled
        ? loadManifestModelCatalog({
            config: cfg,
            workspaceDir,
            metadataSnapshot,
            fallbackToMetadataScan: false,
          })
        : [];
      fullCatalog = {
        catalog,
        policy: createModelVisibilityPolicy({ ...policyParams, catalog }),
      };
    }
    return fullCatalog;
  };
  const selection = resolveDeferredSelection(params);
  if (selection) {
    const configuredPolicy = createModelVisibilityPolicy({ ...policyParams, catalog: [] });
    if (
      !configuredPolicy.hasProviderWildcards &&
      configuredPolicy.exactModelRefs.every((ref) => parseProviderModelRef(ref) !== null) &&
      hasResolvedThinkingCatalogEntry({
        catalog: configuredPolicy.configuredCatalog,
        ...selection,
      })
    ) {
      return {
        visibilityPolicy: configuredPolicy,
        modelCatalog: [],
        loadDeferredThinkingCatalog: () => loadFullCatalog().policy.catalog,
      };
    }
  }
  const loaded = loadFullCatalog();
  return { visibilityPolicy: loaded.policy, modelCatalog: loaded.catalog };
}
