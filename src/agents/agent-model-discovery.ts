/** Discovers mutable agent session stores using the shared catalog projection. */
import path from "node:path";
import {
  resolveAgentDiscoveryAuthFacts,
  type DiscoverAuthStorageOptions,
} from "./agent-auth-discovery.js";
import {
  normalizeOpenClawModelLookup,
  prepareModelRegistryOptions,
  type DiscoverModelsOptions,
} from "./agent-model-catalog.js";
import type { PersistedPluginModelCatalog } from "./plugin-model-catalog.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

const CAPTURED_MODELS_JSON_SOURCE_PATH = "captured:models.json";

type DiscoverCapturedModelsOptions = Omit<
  DiscoverModelsOptions,
  "modelsJsonContents" | "normalizeModels" | "pluginCatalogs"
> & {
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
};

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
