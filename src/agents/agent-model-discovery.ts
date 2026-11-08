/** Discovers agent models and auth storage with provider/plugin normalization hooks. */
import path from "node:path";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelRegistry as ModelLookup } from "../llm/model-registry.js";
import type { Model } from "../llm/types.js";
import {
  resolveAgentDiscoveryAuthFacts,
  type DiscoverAuthStorageOptions,
} from "./agent-auth-discovery.js";
import { resolveModelPluginMetadataSnapshot } from "./model-discovery-context.js";
import { normalizeDiscoveredAgentModel } from "./model-discovery-normalize.js";
import type {
  PluginModelCatalogMetadataSnapshot,
  PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { buildModelRegistryCatalog } from "./sessions/model-registry-catalog.js";
import {
  getModelRegistryProviderRequestConfig,
  hasModelRegistryConfiguredAuth,
} from "./sessions/model-registry-request-auth.js";
import { ModelRegistry } from "./sessions/model-registry.js";

const CAPTURED_MODELS_JSON_SOURCE_PATH = "captured:models.json";

type DiscoverModelsOptions = {
  config?: OpenClawConfig;
  includePluginCatalogs?: boolean;
  modelsJsonContents?: string | null;
  pluginCatalogs?: readonly PersistedPluginModelCatalog[];
  staticProviderConfigs?: Readonly<Record<string, ModelProviderConfig>>;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  workspaceDir?: string;
  normalizeModels?: boolean;
};

type DiscoverCapturedModelsOptions = Omit<
  DiscoverModelsOptions,
  "modelsJsonContents" | "normalizeModels" | "pluginCatalogs"
> & {
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
};

function prepareModelRegistryOptions(options?: DiscoverModelsOptions) {
  const pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
    ...(options?.config ? { config: options.config } : {}),
    ...(options?.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: options.pluginMetadataSnapshot }
      : {}),
    ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    allowWorkspaceScopedCurrent: options?.workspaceDir === undefined,
  });
  return {
    config: options?.config,
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(options?.includePluginCatalogs !== undefined
      ? { includePluginCatalogs: options.includePluginCatalogs }
      : {}),
    ...(options?.modelsJsonContents !== undefined
      ? { modelsJsonContents: options.modelsJsonContents }
      : {}),
    ...(options?.pluginCatalogs !== undefined ? { pluginCatalogs: options.pluginCatalogs } : {}),
    staticProviderConfigs: options?.staticProviderConfigs,
  };
}

function normalizeOpenClawModelLookup(
  registry: ModelLookup,
  agentDir: string | undefined,
  providerMetadataOwners: PluginModelCatalogMetadataSnapshot["owners"] | undefined,
  options?: DiscoverModelsOptions,
): () => void {
  const getAll = registry.getAll.bind(registry);
  const getAvailable = registry.getAvailable.bind(registry);
  const find = registry.find.bind(registry);
  const shouldNormalize = options?.normalizeModels !== false;
  const findCache = new Map<string, Model | undefined>();
  const normalizeEntry = (entry: Model) => {
    if (!shouldNormalize) {
      return entry;
    }
    if (!agentDir) {
      throw new Error("agent directory is required for model normalization");
    }
    return normalizeDiscoveredAgentModel(entry, agentDir, {
      ...options,
      ...(providerMetadataOwners ? { providerMetadataOwners } : {}),
    });
  };

  registry.getAll = () => getAll().map(normalizeEntry);
  registry.getAvailable = () => getAvailable().map(normalizeEntry);
  registry.find = (provider: string, modelId: string) => {
    const key = `${provider}\0${modelId}`;
    if (findCache.has(key)) {
      return findCache.get(key);
    }
    const fallbackEntry = find(provider, modelId);
    const resolved = fallbackEntry ? normalizeEntry(fallbackEntry) : undefined;
    findCache.set(key, resolved);
    return resolved;
  };
  return () => findCache.clear();
}

function normalizeOpenClawModelRegistry(
  registry: ModelRegistry,
  agentDir: string | undefined,
  options?: DiscoverModelsOptions,
): ModelRegistry {
  const clearFindCache = normalizeOpenClawModelLookup(
    registry,
    agentDir,
    registry.getProviderMetadataOwners(),
    options,
  );
  const refresh = registry.refresh.bind(registry);
  const refreshAsync = registry.refreshAsync.bind(registry);
  registry.refresh = () => {
    clearFindCache();
    return refresh();
  };
  registry.refreshAsync = async () => {
    await refreshAsync();
    clearFindCache();
  };
  return registry;
}

/** Catalog publication needs lookup and availability, without a mutable session or backup. */
export function discoverModelCatalog(
  authStorage: AuthStorage,
  agentDir: string,
  options: DiscoverModelsOptions & {
    modelsJsonContents: string | null;
    pluginCatalogs: readonly PersistedPluginModelCatalog[];
  },
): ModelLookup {
  const prepared = prepareModelRegistryOptions(options);
  const { models, providerRequestConfigs } = buildModelRegistryCatalog(
    authStorage,
    path.join(agentDir, "models.json"),
    prepared,
  );
  const lookup = createModelCatalogLookup(models, (model) =>
    hasModelRegistryConfiguredAuth({
      model,
      providerConfig: getModelRegistryProviderRequestConfig(model, providerRequestConfigs),
      authStorage,
    }),
  );
  normalizeOpenClawModelLookup(lookup, agentDir, prepared.pluginMetadataSnapshot?.owners, options);
  return lookup;
}

/** Reuse route-scoped availability when projecting accepted serving limits onto catalog rows. */
export function createModelCatalogLookup(
  models: Model[],
  hasConfiguredAuth: ModelLookup["hasConfiguredAuth"],
): ModelLookup {
  return {
    getAll: () => models,
    getAvailable: () => models.filter(hasConfiguredAuth),
    find: (provider, modelId) =>
      models.find((model) => model.provider === provider && model.id === modelId),
    hasConfiguredAuth,
  };
}

/** Captures the effective profile store and its AuthStorage projection as one generation. */
export async function discoverAuthStorageFacts(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): Promise<{
  authStorage: AuthStorage;
  store: import("./auth-profiles/types.js").AuthProfileStore;
  credentials: import("./agent-auth-credentials.js").AgentCredentialMap;
}> {
  const facts =
    options?.skipCredentials === true
      ? { store: { version: 1, profiles: {} }, credentials: {} }
      : await resolveAgentDiscoveryAuthFacts(agentDir, options);
  return { ...facts, authStorage: AuthStorage.inMemory(facts.credentials) };
}

/** Discover persisted catalogs off the Gateway thread before publishing normalized models. */
export async function discoverModelsAsync(
  authStorage: AuthStorage,
  agentDir: string,
  options?: DiscoverModelsOptions,
): Promise<ModelRegistry> {
  const registry = await ModelRegistry.createAsync(
    authStorage,
    path.join(agentDir, "models.json"),
    prepareModelRegistryOptions(options),
  );
  return normalizeOpenClawModelRegistry(registry, agentDir, options);
}

/**
 * Parses complete lifecycle-captured sources without retaining an agent-directory dependency.
 * Callers may share the resulting immutable catalog snapshot across exact source generations.
 */
export function discoverModelsFromCapturedSources(
  authStorage: AuthStorage,
  options: DiscoverCapturedModelsOptions,
): ModelRegistry {
  const registry = ModelRegistry.fromCapturedSources(
    authStorage,
    CAPTURED_MODELS_JSON_SOURCE_PATH,
    { ...prepareModelRegistryOptions(options), pluginCatalogs: options.pluginCatalogs },
  );
  return normalizeOpenClawModelRegistry(registry, undefined, {
    ...options,
    normalizeModels: false,
  });
}
