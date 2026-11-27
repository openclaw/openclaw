import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { collectConfiguredCatalogModels } from "./configured-model-entries.js";
import { projectClaudeCliNativeCatalog } from "./model-catalog-cli-wildcard.js";
import { loadManifestModelCatalog } from "./model-catalog.js";
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
  const project = (
    inventory: Pick<PreparedModelCatalogInventory, "catalog"> &
      Partial<Pick<PreparedModelCatalogInventory, "discoveryOrigins" | "providers">>,
    configuredRuntimeModels = params.catalogFacts.configuredRuntimeModels,
  ) => {
    const { catalog, discoveryOrigins = [], providers: acquiredProviders } = inventory;
    let sourceCatalog = catalog;
    if (acquiredProviders) {
      // Retained siblings cannot hide captured rows before this provider is acquired.
      // Acquisition owns account observations, including typed-only rows. Only actual
      // manifest declarations survive independently of a successful empty discovery.
      const keyOf = createModelCatalogIdentityKeyResolver();
      const declaredKeys = new Set(
        loadManifestModelCatalog({
          config: params.agentFacts.input.config,
          metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        })
          .filter((entry) => entry.inference?.chat === false)
          .map(keyOf),
      );
      const unacquired = (entries: typeof catalog.entries) =>
        entries.filter(
          (entry) =>
            !entry.nativeRuntime &&
            ((entry.inference?.chat === false && declaredKeys.has(keyOf(entry))) ||
              !acquiredProviders.has(params.normalizeProvider(entry.provider))),
        );
      sourceCatalog = {
        ...catalog,
        entries: [...catalog.entries, ...unacquired(params.catalogFacts.modelCatalog.entries)],
        routeVariants: [
          ...catalog.routeVariants,
          ...unacquired(params.catalogFacts.modelCatalog.routeVariants),
        ],
      };
    }
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
      sourceCatalog,
      !(getPreparedModelFullCatalogAuth(catalog)?.credentials ?? params.agentFacts.credentials)
        .anthropic,
      () =>
        loadManifestModelCatalog({
          config: params.agentFacts.input.config,
          metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        }),
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
  // Materialization and final identity deduplication resolve provider policies too.
  return (...args: Parameters<typeof project>) =>
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: params.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: params.pluginGeneration.pluginRegistry,
      },
      () => project(...args),
    );
}
