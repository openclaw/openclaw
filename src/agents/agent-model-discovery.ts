/** Discovers agent models and auth storage with provider/plugin normalization hooks. */
import path from "node:path";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

function createOpenClawModelRegistry(
  authStorage: AuthStorage,
  modelsJsonPath: string,
  agentDir: string | undefined,
  options?: DiscoverModelsOptions,
): ModelRegistry {
  const pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
    ...(options?.config ? { config: options.config } : {}),
    ...(options?.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: options.pluginMetadataSnapshot }
      : {}),
    ...(options?.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
    allowWorkspaceScopedCurrent: options?.workspaceDir === undefined,
  });
  const registryOptions = {
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
  const registry = ModelRegistry.create(authStorage, modelsJsonPath, registryOptions);
  const getAll = registry.getAll.bind(registry);
  const getAvailable = registry.getAvailable.bind(registry);
  const find = registry.find.bind(registry);
  const refresh = registry.refresh.bind(registry);
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
      ...(pluginMetadataSnapshot?.owners
        ? { providerMetadataOwners: pluginMetadataSnapshot.owners }
        : {}),
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
  registry.refresh = () => {
    findCache.clear();
    return refresh();
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

/** Creates a model registry for one agent directory with optional plugin normalization. */
export function discoverModels(
  authStorage: AuthStorage,
  agentDir: string,
  options?: DiscoverModelsOptions,
): ModelRegistry {
  return createOpenClawModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
    agentDir,
    options,
  );
}

/**
 * Parses complete lifecycle-captured sources without retaining an agent-directory dependency.
 * Callers may share the resulting immutable catalog snapshot across exact source generations.
 */
export function discoverModelsFromCapturedSources(
  authStorage: AuthStorage,
  options: DiscoverCapturedModelsOptions,
): ModelRegistry {
  return createOpenClawModelRegistry(authStorage, CAPTURED_MODELS_JSON_SOURCE_PATH, undefined, {
    ...options,
    normalizeModels: false,
  });
}
