import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { prepareConfiguredRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";

/** Composes retained discovery with current configured metadata and runtime capabilities. */
export function createPreparedModelCatalogProjection(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  normalizeProvider: (provider: string) => string;
  catalogFacts: PreparedModelRuntimeCatalogFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
}) {
  return (
    catalog: ModelCatalogSnapshot,
    configuredRuntimeModels: PreparedModelRuntimeCatalogFacts["configuredRuntimeModels"],
  ) => {
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
    const projected = materializePreparedModelCatalog(
      catalog,
      params.agentFacts.runtimeCapabilityModels,
      current.staticEntries,
    );
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
    const keyOf = createModelCatalogIdentityKeyResolver();
    projected.entries = dedupeByKey([...projected.entries, ...current.entries], keyOf);
    projected.routeVariants = dedupeByKey(
      [...projected.routeVariants, ...current.routeVariants],
      (entry) => JSON.stringify([keyOf(entry), entry.api, entry.baseUrl, entry.nativeRuntime]),
    );
    prepareModelCatalogThinkingPolicies({
      catalog: projected,
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      providers: params.pluginGeneration.pluginRegistry?.providers,
    });
    return projected;
  };
}
