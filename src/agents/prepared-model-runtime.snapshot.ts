import type { Model } from "../llm/types.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { getPreparedRuntimeAuthMaterializations } from "./auth-profiles/runtime-materializations.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { bindPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogAccess,
  PreparedModelRuntimeCatalogFacts,
} from "./prepared-model-runtime.catalog-contract.js";
import { prepareConfiguredModelAliases } from "./prepared-model-runtime.configured-completion.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";
import { acquirePreparedMediaCapabilityProviders } from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

// Host session publication owns SDK constructors; catalog workers never need
// their standalone config defaults or persistence factories.
export function createPreparedModelRuntimeSnapshot(
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"],
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogFacts: PreparedModelRuntimeCatalogFacts,
  catalogAccess: PreparedModelRuntimeCatalogAccess,
  publishedConfig = agentFacts.input.config,
): PreparedModelRuntimeSnapshot {
  const { credentials, input } = agentFacts;
  const {
    inlineProviderModels,
    mediaCapabilityProviders,
    mediaCapabilityProviderSource,
    messageToolCatalog,
    pluginMetadataSnapshot,
    pluginRegistry,
  } = pluginGeneration;
  const { configuredRuntimeModels, templateModelRegistry } = catalogFacts;
  const modelCatalog = materializePreparedModelCatalog(
    catalogFacts.modelCatalog,
    agentFacts.runtimeCapabilityModels,
    input.config.models?.mode === "replace"
      ? []
      : configuredRuntimeModels.map(({ model }) => modelCatalogRowToEntry(model)),
  );
  prepareModelCatalogThinkingPolicies({
    catalog: modelCatalog,
    metadataSnapshot: pluginMetadataSnapshot,
    pluginRegistry,
  });
  const snapshot: PreparedModelRuntimeSnapshot = Object.freeze({
    catalogOwner,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    activeProjectKeys: [],
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: publishedConfig,
    observationConfig: input.config,
    isCurrent: catalogAccess.isCurrent,
    accountCatalog: catalogAccess.accountCatalog,
    authModes: catalogAccess.initialAuth.authModes,
    metadataSnapshot: pluginMetadataSnapshot,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ...(messageToolCatalog ? { messageToolCatalog } : {}),
    ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
    ...(mediaCapabilityProviderSource && mediaCapabilityProviders
      ? {
          acquireMediaCapabilityProviders: () =>
            acquirePreparedMediaCapabilityProviders(
              mediaCapabilityProviderSource,
              mediaCapabilityProviders,
              pluginRegistry ?? mediaCapabilityProviderSource.registry,
            ),
        }
      : {}),
    modelCatalog: catalogAccess.withRefreshStatus(modelCatalog),
    readFullModelCatalog: catalogAccess.readFullModelCatalog,
    recheckNativeLogin: catalogAccess.recheckNativeLogin,
    refreshExpiredModelCatalog: catalogAccess.refreshExpiredModelCatalog,
    readPublishedModels: catalogAccess.readPublishedModels,
    loadFullModelCatalog: catalogAccess.loadFullModelCatalog,
    loadNativeModelCatalog: catalogAccess.loadNativeModelCatalog,
    configuredRuntimeModels,
    configuredModelAliases: prepareConfiguredModelAliases(
      agentFacts,
      pluginGeneration,
      templateModelRegistry,
      configuredRuntimeModels,
    ),
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      pluginMetadataSnapshot,
    ),
    inlineProviderModels,
    createStores: (publishedModels?: ReadonlyMap<string, readonly Model[]>) => {
      // Runtime keys and session extensions mutate per-run stores; parsed inputs stay shared.
      const authStorage = AuthStorage.inMemory(credentials);
      return {
        authStorage,
        // Catalogs may come from the light core; sessions expose the public SDK class.
        modelRegistry: ModelRegistry.prototype.fork.call(
          templateModelRegistry,
          authStorage,
          publishedModels,
        ),
      };
    },
    routeModelResolutionMemo: new Map<string, Promise<Model>>(),
  });
  bindPreparedModelRuntimeAuth(snapshot, {
    labels: catalogAccess.initialAuth.providerAuthLabels,
    store: catalogAccess.initialAuth.authStore,
    readUsage: catalogAccess.readUsage,
    load: catalogAccess.loadAuth,
    materializations: Object.freeze([...getPreparedRuntimeAuthMaterializations(input.agentDir)]),
  });
  return snapshot;
}
