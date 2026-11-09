/** Catalog-only model discovery shares the parser and normalization policy with sessions. */
import path from "node:path";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelRegistry as ModelLookup } from "../llm/model-registry.js";
import type { Model } from "../llm/types.js";
import { resolveModelPluginMetadataSnapshot } from "./model-discovery-context.js";
import { normalizeDiscoveredAgentModel } from "./model-discovery-normalize.js";
import type {
  PluginModelCatalogMetadataSnapshot,
  PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";
import type { ReadonlyAuthStorage } from "./sessions/auth-storage-types.js";
import {
  getModelRegistryProviderRequestConfig,
  hasModelRegistryConfiguredAuth,
} from "./sessions/model-registry-availability.js";
import { buildModelRegistryCatalog } from "./sessions/model-registry-catalog.js";

export type DiscoverModelsOptions = {
  config?: OpenClawConfig;
  includePluginCatalogs?: boolean;
  modelsJsonContents?: string | null;
  pluginCatalogs?: readonly PersistedPluginModelCatalog[];
  staticProviderConfigs?: Readonly<Record<string, ModelProviderConfig>>;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  workspaceDir?: string;
  normalizeModels?: boolean;
};

type ModelCatalogLookup = Omit<ModelLookup, "hasConfiguredAuth"> & {
  // Serving-limit projections reuse auth without retaining the original inventory.
  hasConfiguredAuth: (this: void, model: Model) => boolean;
};

export function prepareModelRegistryOptions(options?: DiscoverModelsOptions) {
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

export function normalizeOpenClawModelLookup(
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

/** Catalog publication needs lookup and availability, without a mutable session or backup. */
export function discoverModelCatalog(
  authStorage: ReadonlyAuthStorage,
  agentDir: string,
  options: DiscoverModelsOptions & {
    modelsJsonContents: string | null;
    pluginCatalogs: readonly PersistedPluginModelCatalog[];
  },
): ModelCatalogLookup {
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
  hasConfiguredAuth: ModelCatalogLookup["hasConfiguredAuth"],
): ModelCatalogLookup {
  return {
    getAll: () => models,
    getAvailable: () => models.filter(hasConfiguredAuth),
    find: (provider, modelId) =>
      models.find((model) => model.provider === provider && model.id === modelId),
    hasConfiguredAuth,
  };
}
