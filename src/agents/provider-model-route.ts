/** Generic core consumers for provider-owned model route facts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  findConfiguredProviderModel,
  projectModelProviderConfig,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import { getRuntimeConfigCapture } from "../config/runtime-config-capture-state.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
} from "../config/runtime-snapshot.js";
import {
  captureRuntimeConfig,
  projectConfigOntoRuntimeSourceSnapshot,
} from "../config/runtime-source-projection.js";
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
import type { ModelCatalogEntry } from "./model-catalog.types.js";
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
export function createProviderModelCatalogRoutePolicy(providerId: string) {
  const provider = normalizeProviderId(providerId);
  return {
    resolveIdentity: (entry: Pick<ModelCatalogEntry, "provider" | "id">) => {
      if (normalizeProviderId(entry.provider) !== provider) {
        return null;
      }
      const id = resolveProviderModelCatalogId({
        provider,
        modelId: splitTrailingAuthProfile(entry.id).model,
      });
      return id ? { id, key: `${provider}/${id}` } : null;
    },
    matchesRoute: (entry: ModelCatalogEntry, route: ProviderModelRouteCandidate) =>
      normalizeProviderId(entry.provider) === provider &&
      modelMatchesProviderModelRoute({
        provider,
        api: entry.api,
        baseUrl: entry.baseUrl,
        route,
      }),
  };
}

const preparedRouteConfigs = new WeakMap<
  OpenClawConfig,
  {
    snapshot: ReturnType<typeof getRuntimeConfigSnapshotMetadata>;
    routes: Map<string, OpenClawConfig>;
  }
>();

/** Reuses selected-route config within one config generation and source publication. */
export function projectProviderModelRouteConfig(params: {
  provider: string;
  config?: OpenClawConfig;
  route: ProviderModelRouteCandidate;
}): OpenClawConfig {
  // Mutable scoped inputs have no publication owner and must remain uncached.
  const canReuse =
    getRuntimeConfigCapture(params.config) || params.config === getRuntimeConfigSnapshot();
  const key = canReuse
    ? JSON.stringify([
        normalizeProviderId(params.provider),
        params.route.authRequirement,
        params.route.api,
        params.route.baseUrl,
      ])
    : undefined;
  const snapshot = getRuntimeConfigSnapshotMetadata();
  const cached = params.config && preparedRouteConfigs.get(params.config);
  const routes = cached?.snapshot === snapshot ? cached.routes : undefined;
  const previous = key && routes?.get(key);
  if (previous) {
    return previous;
  }
  const projected = projectModelProviderConfig(params.config, params.provider, {
    auth: params.route.authRequirement === "subscription" ? "oauth" : "api-key",
    api: params.route.api,
    baseUrl: params.route.baseUrl,
  });
  if (!key || !params.config) {
    return projected;
  }
  const config = captureRuntimeConfig(projected);
  const nextRoutes = routes ?? new Map<string, OpenClawConfig>();
  nextRoutes.set(key, config);
  preparedRouteConfigs.set(params.config, { snapshot, routes: nextRoutes });
  return config;
}
