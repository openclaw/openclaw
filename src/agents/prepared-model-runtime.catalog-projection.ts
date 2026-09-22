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
import type {
  PreparedModelCatalogInventory,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";
import { createProviderModelMembership } from "./provider-model-membership.js";

/** Projects retained discovery under the current owner's policy and runtime capabilities. */
export function createPreparedModelCatalogProjection(params: {
  agentFacts: PreparedModelRuntimeAgentFacts;
  catalogFacts: PreparedModelRuntimeCatalogFacts;
  pluginGeneration: PreparedModelRuntimePluginGeneration;
  normalizeProvider: (provider: string) => string;
}) {
  const { normalizeProvider } = params;
  const resolveMembership = createProviderModelMembership({
    cfg: params.agentFacts.input.config,
    agentId: params.agentFacts.input.agentId,
    normalizeProvider,
  });
  return (
    catalog: ModelCatalogSnapshot,
    configuredRuntimeModels: PreparedModelRuntimeCatalogFacts["configuredRuntimeModels"],
    source:
      | Pick<PreparedModelCatalogInventory, "runtimeModels" | "configuredProviderModelIds">
      | undefined,
  ) => {
    const membership = new Map(
      [...(source?.configuredProviderModelIds ?? [])].map(([provider, ids]) => [
        normalizeProvider(provider),
        resolveMembership(provider, ids),
      ]),
    );
    const includesModel = (provider: string, id: string) => {
      const configuredIds = membership.get(normalizeProvider(provider));
      return !configuredIds || configuredIds.has(id.trim());
    };
    const includesEntry = (entry: ModelCatalogSnapshot["entries"][number]) =>
      entry.nativeRuntime || includesModel(entry.provider, entry.id);
    const runtimeModels =
      source &&
      new Map(
        [...source.runtimeModels].map(([provider, models]) => [
          provider,
          models.filter((model) => includesModel(provider, model.id)),
        ]),
      );
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
    const keyOf = createModelCatalogIdentityKeyResolver();
    projected.entries = dedupeByKey(
      [...projected.entries.filter(includesEntry), ...current.entries],
      keyOf,
    );
    projected.routeVariants = dedupeByKey(
      [...projected.routeVariants.filter(includesEntry), ...current.routeVariants],
      (entry) => JSON.stringify([keyOf(entry), entry.api, entry.baseUrl, entry.nativeRuntime]),
    );
    prepareModelCatalogThinkingPolicies({
      catalog: projected,
      metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
      providers: params.pluginGeneration.pluginRegistry?.providers,
    });
    return { catalog: projected, runtimeModels };
  };
}
