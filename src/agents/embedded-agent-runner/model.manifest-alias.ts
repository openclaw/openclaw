import type { ModelCatalogAlias } from "@openclaw/model-catalog-core/model-catalog-types";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planManifestModelCatalogSuppressions } from "../../model-catalog/manifest-planner.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
} from "../../plugins/manifest-owner-policy.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";
import { staticModelIdMatches } from "./model.static-id.js";

function hasConfiguredModelCatalogProviderEndpointSurface(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return false;
  }
  const config = findNormalizedProviderValue(params.cfg?.models?.providers, provider);
  if (config?.baseUrl?.trim()) {
    return true;
  }
  const modelId = params.modelId?.trim();
  if (!modelId || !Array.isArray(config?.models)) {
    return false;
  }
  return config.models.some(
    (model) =>
      Boolean(model.baseUrl?.trim()) &&
      staticModelIdMatches({
        candidateId: model.id,
        provider,
        modelId,
      }),
  );
}

function resolveConfiguredModelCatalogProviderApi(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
}): ModelCatalogAlias["api"] {
  const provider = normalizeProviderId(params.provider);
  const config = provider
    ? findNormalizedProviderValue(params.cfg?.models?.providers, provider)
    : undefined;
  const modelId = params.modelId?.trim();
  const model =
    provider && modelId && Array.isArray(config?.models)
      ? config.models.find((candidate) =>
          staticModelIdMatches({ candidateId: candidate.id, provider, modelId }),
        )
      : undefined;
  return model?.api ?? config?.api;
}

function hasUnconditionalManifestModelCatalogSuppression(params: {
  provider: string;
  modelId?: string;
  plugin: Pick<PluginManifestRecord, "id" | "providers" | "modelCatalog">;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return false;
  }
  return planManifestModelCatalogSuppressions({
    registry: { plugins: [params.plugin] },
    providerFilter: provider,
    modelFilter: modelId,
  }).suppressions.some(
    (suppression) => !suppression.when && normalizeProviderId(suppression.provider) === provider,
  );
}

type ManifestModelCatalogAliasPlugin = Pick<
  PluginManifestRecord,
  | "id"
  | "origin"
  | "enabledByDefault"
  | "enabledByDefaultOnPlatforms"
  | "providers"
  | "modelCatalog"
>;

type ManifestModelCatalogProviderTransport = Readonly<Pick<ModelCatalogAlias, "api" | "baseUrl">>;

export type ManifestModelCatalogProviderAliasMetadata = {
  readonly ambiguous?: true;
  readonly provider: string;
  readonly transport?: ManifestModelCatalogProviderTransport;
};

function listEligibleManifestModelCatalogAliasPlugins(params: {
  cfg?: OpenClawConfig;
  plugins: readonly ManifestModelCatalogAliasPlugin[];
}): readonly ManifestModelCatalogAliasPlugin[] {
  const normalizedConfig = normalizePluginsConfig(params.cfg?.plugins);
  return params.plugins.filter((plugin) => {
    if (
      !isActivatedManifestOwner({
        plugin,
        normalizedConfig,
        rootConfig: params.cfg,
      })
    ) {
      return false;
    }
    return (
      isBundledManifestOwner(plugin) ||
      plugin.origin === "config" ||
      hasExplicitManifestOwnerTrust({ plugin, normalizedConfig })
    );
  });
}

function resolveManifestAliasTargetApi(params: {
  plugin: ManifestModelCatalogAliasPlugin;
  provider: string;
  modelId?: string;
}): ModelCatalogAlias["api"] {
  const providerCatalog = Object.entries(params.plugin.modelCatalog?.providers ?? {}).find(
    ([provider]) => normalizeProviderId(provider) === params.provider,
  )?.[1];
  if (!providerCatalog) {
    return undefined;
  }
  const modelId = params.modelId?.trim();
  const model = modelId
    ? providerCatalog.models.find((candidate) =>
        staticModelIdMatches({
          candidateId: candidate.id,
          provider: params.provider,
          modelId,
        }),
      )
    : undefined;
  return model?.api ?? providerCatalog.api;
}

function resolveManifestModelCatalogProviderAlias(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
  plugins: readonly ManifestModelCatalogAliasPlugin[];
}): ManifestModelCatalogProviderAliasMetadata {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return { provider: params.provider };
  }
  const claims: ManifestModelCatalogProviderAliasMetadata[] = [];
  const plugins = listEligibleManifestModelCatalogAliasPlugins({
    cfg: params.cfg,
    plugins: params.plugins,
  });
  for (const plugin of plugins) {
    for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      const normalizedAlias = normalizeProviderId(rawAlias);
      const normalizedTarget = normalizeProviderId(alias.provider);
      if (
        normalizedAlias !== provider ||
        !normalizedTarget ||
        !plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedTarget)
      ) {
        continue;
      }
      const hasModelId = Boolean(params.modelId?.trim());
      const hasApplicableSuppression =
        hasModelId &&
        hasUnconditionalManifestModelCatalogSuppression({
          provider,
          modelId: params.modelId,
          plugin,
        });
      const hasEndpointSurface =
        Boolean(alias.baseUrl?.trim()) ||
        hasConfiguredModelCatalogProviderEndpointSurface({
          provider,
          modelId: params.modelId,
          cfg: params.cfg,
        });
      const transportApi =
        resolveConfiguredModelCatalogProviderApi({
          provider,
          modelId: params.modelId,
          cfg: params.cfg,
        }) ??
        alias.api ??
        resolveManifestAliasTargetApi({
          plugin,
          provider: normalizedTarget,
          modelId: params.modelId,
        });
      const hasTransportOverride = Boolean(alias.api?.trim() || alias.baseUrl?.trim());
      if (hasTransportOverride && hasEndpointSurface && !hasApplicableSuppression) {
        // A retained endpoint needs an explicit wire adapter. Otherwise the generic
        // model fallback would silently choose OpenAI Responses for another provider.
        const baseUrl = alias.baseUrl?.trim();
        claims.push(
          transportApi
            ? {
                provider: params.provider,
                transport: { api: transportApi, ...(baseUrl ? { baseUrl } : {}) },
              }
            : { provider: params.provider, ambiguous: true },
        );
      } else {
        claims.push({ provider: normalizedTarget });
      }
    }
  }
  return claims.length > 1
    ? { provider: params.provider, ambiguous: true }
    : (claims[0] ?? { provider: params.provider });
}

export function resolveManifestModelCatalogProviderAliasMetadata(params: {
  provider: string;
  modelId?: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ManifestModelCatalogProviderAliasMetadata {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return { provider: params.provider };
  }
  const env = params.env ?? process.env;
  // Gateway plugin metadata is process-stable. Reuse its lifecycle-owned snapshot
  // so every model turn does not rediscover the same manifest alias table.
  const currentPlugins =
    env === process.env
      ? getCurrentPluginMetadataSnapshot({
          config: params.cfg,
          workspaceDir: params.workspaceDir,
          env,
          ...(params.cfg === undefined ? { requireDefaultDiscoveryContext: true } : {}),
        })?.plugins
      : undefined;
  const plugins =
    currentPlugins ??
    loadPluginManifestRegistryCore({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
    }).plugins;
  return resolveManifestModelCatalogProviderAlias({
    provider: params.provider,
    modelId: params.modelId,
    cfg: params.cfg,
    plugins,
  });
}
