import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { collectConfiguredCatalogModels } from "./configured-model-entries.js";
import { projectClaudeCliNativeCatalog } from "./model-catalog-cli-wildcard.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { prepareConfiguredRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";
import type {
  PreparedModelRuntimePluginGeneration,
  PreparedModelCatalogInventory,
} from "./prepared-model-runtime.types.js";

/** Composes retained discovery with current configured metadata and runtime capabilities. */
export function createPreparedModelCatalogProjection(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  normalizeProvider: (provider: string) => string;
  catalogFacts: PreparedModelRuntimeCatalogFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}) {
  const configuredModels = collectConfiguredCatalogModels(params.agentFacts.input.config);
  const providers = [
    ...(params.pluginGeneration.preparedStaticProviderCatalog?.providers ?? []),
    ...(params.pluginGeneration.pluginRegistry?.providers.map(({ provider }) => provider) ?? []),
  ];
  return (
    inventory: Pick<PreparedModelCatalogInventory, "catalog"> &
      Partial<Pick<PreparedModelCatalogInventory, "discoveryOrigins">>,
    configuredRuntimeModels = params.catalogFacts.configuredRuntimeModels,
  ) => {
    const { catalog, discoveryOrigins = [] } = inventory;
    const configured = prepareConfiguredRuntimeFacts({
      agentFacts: params.agentFacts,
      workspaceFacts: params.pluginGeneration,
      templateModelRegistry: params.catalogFacts.templateModelRegistry,
      configuredRuntimeModels,
    }).modelCatalog;
    const current = materializePreparedModelCatalog(
      configured,
      params.agentFacts.runtimeCapabilityModels,
    );
    // Retain source-owned rows before projecting native IDs onto their public provider.
    const nativeCatalog = projectClaudeCliNativeCatalog(
      catalog,
      !(getPreparedModelFullCatalogAuth(catalog)?.credentials ?? params.agentFacts.credentials)
        .anthropic,
    );
    const projected = materializePreparedModelCatalog(
      nativeCatalog,
      params.agentFacts.runtimeCapabilityModels,
      current.staticEntries,
      new Set(discoveryOrigins.map(({ provider }) => params.normalizeProvider(provider))),
    );
    projected.acceptedDiscoveryOrigins = discoveryOrigins;
    // Native discovery cannot replace the authentication facts of an API provider.
    const apiProviders = new Set(
      projected.providerOutcomes?.map(({ provider }) => params.normalizeProvider(provider)),
    );
    const nativeOutcomes = Object.values(catalog.nativeProviderOutcomes ?? {})
      .flat()
      .filter(({ provider }) => !apiProviders.has(params.normalizeProvider(provider)));
    if (nativeOutcomes.length) {
      projected.providerOutcomes = [...(projected.providerOutcomes ?? []), ...nativeOutcomes];
    }
    // Server evidence survives config reload; advisory results belong to this config projection.
    projected.providerOutcomes = projected.providerOutcomes?.map((outcome) => {
      const listing = outcome.status === "ready" ? outcome.modelIdCatalog : undefined;
      if (!listing) {
        return outcome;
      }
      const provider = params.normalizeProvider(outcome.provider);
      const references = configuredModels
        .filter((model) => params.normalizeProvider(model.provider) === provider)
        .map((model) => Object.assign({}, model, { provider }));
      const match = providers.find(
        (candidate) =>
          matchesProviderPluginRef(candidate, provider) &&
          candidate.catalog?.getUnlistedConfiguredModelIds,
      )?.catalog?.getUnlistedConfiguredModelIds;
      const unlistedConfiguredModelIds = match
        ? match(listing, references)
        : references
            .filter(
              (model) =>
                (!model.baseUrl ||
                  model.baseUrl.replace(/\/+$/, "") === listing.baseUrl.replace(/\/+$/, "")) &&
                !listing.modelIds.includes(model.modelId.trim()),
            )
            .map((model) => model.modelId);
      return { ...outcome, unlistedConfiguredModelIds };
    });
    const keyOf = createModelCatalogIdentityKeyResolver();
    projected.entries = dedupeByKey([...projected.entries, ...current.entries], keyOf);
    projected.routeVariants = dedupeByKey(
      [...projected.routeVariants, ...current.routeVariants],
      (entry) => JSON.stringify([keyOf(entry), entry.api, entry.baseUrl, entry.nativeRuntime]),
    );
    prepareModelCatalogThinkingPolicies({
      catalog: projected,
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: params.pluginGeneration.pluginRegistry,
    });
    return projected;
  };
}
