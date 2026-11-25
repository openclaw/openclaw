import { supportsNativeOpenAIResponsesEndpoint } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderFastModePolicyContext } from "../plugin-sdk/provider-model-types.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../plugins/plugin-cache.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";
import { resolveProviderFastModeRequestCapabilities } from "./provider-attribution.js";

/** Capture light policy with the private catalog owner; published row reads cannot load plugins. */
export function createModelSpeedPolicyResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  catalog: readonly ModelCatalogEntry[];
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
}) {
  const policies = withPluginCache(
    getPluginMetadataSnapshotCache(params.metadataSnapshot),
    () =>
      new Map(
        [...new Set(params.catalog.map((entry) => normalizeProviderId(entry.provider)))].map(
          (provider) => {
            const registered = params.pluginRegistry?.providers.find(({ provider: candidate }) =>
              matchesProviderPluginRef(candidate, provider),
            )?.provider;
            const policy = resolveProviderPolicySurface(provider, {
              manifestRegistry: params.metadataSnapshot.manifestRegistry,
            });
            return [
              provider,
              {
                resolveFastModeSupport:
                  registered?.resolveFastModeSupport ?? policy?.resolveFastModeSupport,
                resolveServiceTiers: registered?.resolveServiceTiers ?? policy?.resolveServiceTiers,
              },
            ] as const;
          },
        ),
      ),
  );
  const prepare = (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId?: string,
  ): {
    supportsFastMode?: boolean;
    serviceTiers?: readonly string[];
    supportsServiceTierRecovery?: boolean;
  } => {
    const policy = policies.get(normalizeProviderId(entry.provider));
    if (!policy) {
      return {};
    }
    const route = evaluation.selectedRoute ?? entry;
    if (!policy.resolveFastModeSupport && !policy.resolveServiceTiers) {
      return {
        supportsFastMode: undefined,
        serviceTiers: undefined,
        supportsServiceTierRecovery:
          (runtimeId ?? entry.nativeRuntime) === "openclaw" &&
          supportsNativeOpenAIResponsesEndpoint({
            provider: entry.provider,
            api: route.api ?? "",
            baseUrl: route.baseUrl,
          }),
      };
    }
    const { defaultParams, modelParams, agentModelParams, agentParams } =
      resolveModelExtraParamSources({
        config: params.cfg,
        provider: entry.provider,
        modelId: entry.id,
        agentId: params.agentId,
      });
    const context: ProviderFastModePolicyContext = {
      provider: entry.provider,
      modelId: entry.id,
      api: route.api,
      baseUrl: route.baseUrl,
      authMode: evaluation.selectedAuthMode,
      runtimeId: runtimeId ?? entry.nativeRuntime,
      modelParams: entry.params,
      params: Object.assign({}, defaultParams, modelParams, agentModelParams, agentParams),
      requestCapabilities: resolveProviderFastModeRequestCapabilities({
        provider: entry.provider,
        api: route.api,
        baseUrl: route.baseUrl,
        providerMetadataOwners: params.metadataSnapshot.owners,
      }),
    };
    return {
      supportsFastMode: policy.resolveFastModeSupport?.(context),
      serviceTiers: policy.resolveServiceTiers?.(context),
      supportsServiceTierRecovery:
        context.runtimeId === "openclaw" &&
        supportsNativeOpenAIResponsesEndpoint({
          provider: entry.provider,
          api: route.api ?? "",
          baseUrl: route.baseUrl,
        }),
    };
  };
  // These are local request-mapping facts, not account readiness or service-tier observations.
  // The catalog owner retires this resolver with its config, metadata and auth generation.
  const prepared = new WeakMap<
    ModelCatalogEntry,
    Array<{
      api: string | undefined;
      baseUrl: string | undefined;
      authMode: string | undefined;
      runtimeId: string | undefined;
      policy: ReturnType<typeof prepare>;
    }>
  >();
  return (
    entry: ModelCatalogEntry,
    evaluation: ModelAuthAvailabilityEvaluation,
    runtimeId = entry.nativeRuntime,
  ): ReturnType<typeof prepare> => {
    if (evaluation.routeResolution !== null && !evaluation.selectedRoute) {
      return {};
    }
    const { api, baseUrl } = evaluation.selectedRoute ?? entry;
    const authMode = evaluation.selectedAuthMode;
    const variants = prepared.get(entry) ?? [];
    const existing = variants.find(
      (variant) =>
        variant.api === api &&
        variant.baseUrl === baseUrl &&
        variant.authMode === authMode &&
        variant.runtimeId === runtimeId,
    );
    if (existing) {
      return existing.policy;
    }
    const policy = prepare(entry, evaluation, runtimeId);
    variants.push({ api, baseUrl, authMode, runtimeId, policy });
    prepared.set(entry, variants);
    return policy;
  };
}
