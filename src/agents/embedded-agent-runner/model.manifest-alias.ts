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
import { loadPluginManifestRegistryCore } from "../../plugins/manifest-registry.js";
import { staticModelIdMatches } from "./model.static-id.js";

type ManifestModelCatalogProviderTransport = Readonly<Pick<ModelCatalogAlias, "api" | "baseUrl">>;

export type ManifestModelCatalogProviderAliasMetadata = {
  readonly ambiguous?: true;
  readonly provider: string;
  readonly transport?: ManifestModelCatalogProviderTransport;
};

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
  const claims: ManifestModelCatalogProviderAliasMetadata[] = [];
  const normalizedConfig = normalizePluginsConfig(params.cfg?.plugins);
  for (const plugin of plugins) {
    if (
      !isActivatedManifestOwner({ plugin, normalizedConfig, rootConfig: params.cfg }) ||
      !(
        isBundledManifestOwner(plugin) ||
        plugin.origin === "config" ||
        hasExplicitManifestOwnerTrust({ plugin, normalizedConfig })
      )
    ) {
      continue;
    }
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
      const modelId = params.modelId?.trim();
      const hasApplicableSuppression =
        modelId &&
        planManifestModelCatalogSuppressions({
          registry: { plugins: [plugin] },
          providerFilter: provider,
          modelFilter: modelId,
        }).suppressions.some(
          (suppression) =>
            !suppression.when && normalizeProviderId(suppression.provider) === provider,
        );
      const config = findNormalizedProviderValue(params.cfg?.models?.providers, provider);
      const configuredModelId = params.modelId?.trim() ?? "";
      const models = config?.models ?? [];
      const matches = (candidate: { id: string }) =>
        Boolean(provider && configuredModelId) &&
        staticModelIdMatches({ candidateId: candidate.id, provider, modelId: configuredModelId });
      const configuredRoute = {
        hasEndpoint:
          Boolean(config?.baseUrl?.trim()) ||
          models.some((model) => Boolean(model.baseUrl?.trim()) && matches(model)),
        api: models.find(matches)?.api ?? config?.api,
      };
      const hasEndpointSurface = Boolean(alias.baseUrl?.trim()) || configuredRoute.hasEndpoint;
      const transportApi =
        configuredRoute.api ??
        alias.api ??
        (() => {
          const providerCatalog = findNormalizedProviderValue(
            plugin.modelCatalog?.providers,
            normalizedTarget,
          );
          if (!providerCatalog) {
            return undefined;
          }
          const targetModelId = params.modelId?.trim();
          const model = targetModelId
            ? providerCatalog.models.find((candidate) =>
                staticModelIdMatches({
                  candidateId: candidate.id,
                  provider: normalizedTarget,
                  modelId: targetModelId,
                }),
              )
            : undefined;
          return model?.api ?? providerCatalog.api;
        })();
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
