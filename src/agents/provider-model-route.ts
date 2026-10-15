/** Generic core consumers for provider-owned model route facts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  findConfiguredProviderModel,
  projectModelProviderConfig,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { ModelApi, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { getCurrentPluginMetadataSnapshotRequiredRuntime } from "../plugins/plugin-metadata-snapshot-required.js";
import {
  resolveProviderModelCatalogId,
  resolveProviderModelPolicySurface,
  resolveProviderModelRoutes,
} from "../plugins/provider-model-routes.js";
import { listProviderPolicyOwners } from "../plugins/provider-policy-owners.js";
import type { ModelCatalogRoutePolicy } from "./model-catalog-route.js";
import { normalizeCatalogRouteBaseUrl } from "./model-compat-catalog.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

/** Canonicalizes a model id only when its provider owns catalog equivalence. */
export function canonicalizeProviderModelId(providerId: string, modelId: string): string {
  const provider = normalizeProviderId(providerId);
  return (provider && resolveProviderModelCatalogId({ provider, modelId })) || modelId;
}

/** Provider and authored custom-row equivalence do not change the selected OpenClaw route. */
export function isProviderModelRerouted(
  requested: { provider: string; model: string },
  effective: { provider: string; model: string; responseModel?: string },
  config?: OpenClawConfig,
): boolean {
  const provider = normalizeProviderId(requested.provider);
  if (provider !== normalizeProviderId(effective.provider)) {
    return true;
  }
  const surface = provider ? resolveProviderModelPolicySurface(provider) : null;
  const canonicalize = (modelId: string) =>
    resolveProviderModelCatalogId({ provider, modelId, surface }) ?? modelId;
  const model = canonicalize(requested.model);
  if (canonicalize(effective.model) !== model) {
    return true;
  }
  const responseModel = effective.responseModel;
  if (responseModel === undefined || canonicalize(responseModel) === model) {
    return false;
  }
  if (
    surface?.isResponseModelEquivalent?.({
      provider,
      requestedModelId: requested.model,
      responseModelId: responseModel,
    }) === true
  ) {
    return false;
  }
  if (surface || !config) {
    return true;
  }
  const source = projectConfigOntoRuntimeSourceSnapshot(config);
  const row = findConfiguredProviderModel(
    resolveMergedModelProviderConfig(source, provider),
    provider,
    requested.model,
    canonicalize,
  );
  if (row?.responseModelEquivalent !== true || row.metadataSource === "models-add") {
    return true;
  }
  // Official ownership remains authoritative even when it supplies no policy artifact.
  const metadata = getCurrentPluginMetadataSnapshotRequiredRuntime({
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  if (!metadata) {
    return false;
  }
  return (
    listProviderPolicyOwners(provider, metadata).length > 0 ||
    (metadata.owners.modelCatalogProviders.get(provider) ?? []).some((pluginId) => {
      const owner = metadata.byPluginId.get(pluginId);
      return owner?.origin === "bundled" || owner?.trustedOfficialInstall === true;
    })
  );
}

function routeTupleMatches(
  source: { api?: string | null; baseUrl?: string },
  route: ProviderModelRouteCandidate,
): boolean {
  return (
    source.api === route.api &&
    source.baseUrl !== undefined &&
    (normalizeCatalogRouteBaseUrl(source.baseUrl) ?? "") ===
      (normalizeCatalogRouteBaseUrl(route.baseUrl) ?? "")
  );
}

/** True when materialized model metadata belongs to the selected provider route. */
export function modelMatchesProviderModelRoute(params: {
  provider: string;
  api?: string | null;
  baseUrl?: string;
  route: ProviderModelRouteCandidate;
}): boolean {
  if (routeTupleMatches(params, params.route)) {
    return true;
  }
  if (
    typeof params.api !== "string" ||
    !params.api.trim() ||
    params.api !== params.route.api ||
    typeof params.baseUrl !== "string" ||
    !params.baseUrl.trim()
  ) {
    return false;
  }

  // Re-resolve through the owner only to canonicalize endpoint spelling.
  const configuredProvider = {
    api: params.api as ModelApi,
    baseUrl: params.baseUrl,
    models: [],
  } satisfies ModelProviderConfig;
  const provider = normalizeProviderId(params.provider);
  const resolution = resolveProviderModelRoutes({
    provider,
    config: { models: { providers: { [provider]: configuredProvider } } },
  });
  return (
    resolution?.kind === "routes" &&
    resolution.routes.some(
      (candidate) =>
        candidate.authRequirement === params.route.authRequirement &&
        routeTupleMatches(candidate, params.route),
    )
  );
}

/** Creates catalog equivalence and physical-route matching from provider facts. */
export function createProviderModelCatalogRoutePolicy(providerId: string): ModelCatalogRoutePolicy {
  const provider = normalizeProviderId(providerId);
  return {
    resolveIdentity: (entry) => {
      if (normalizeProviderId(entry.provider) !== provider) {
        return null;
      }
      const id = resolveProviderModelCatalogId({
        provider,
        modelId: splitTrailingAuthProfile(entry.id).model,
      });
      return id ? { id, key: `${provider}/${id}` } : null;
    },
    matchesRoute: (entry, route) =>
      normalizeProviderId(entry.provider) === provider &&
      modelMatchesProviderModelRoute({
        provider,
        api: entry.api,
        baseUrl: entry.baseUrl,
        route,
      }),
  };
}

/** Projects a selected route onto transient config used only for model materialization. */
export function projectProviderModelRouteConfig(params: {
  provider: string;
  config?: OpenClawConfig;
  route: ProviderModelRouteCandidate;
}): OpenClawConfig {
  return projectModelProviderConfig(params.config, params.provider, {
    auth: params.route.authRequirement === "subscription" ? "oauth" : "api-key",
    api: params.route.api,
    baseUrl: params.route.baseUrl,
  });
}
