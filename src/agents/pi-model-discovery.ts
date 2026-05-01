import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";
import { isRecord } from "../utils.js";
import type { PiCredentialMap } from "./pi-auth-credentials.js";
import {
  resolvePiCredentialsForDiscovery,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./pi-auth-discovery.js";
import { normalizeProviderId } from "./provider-id.js";

const PiAuthStorageClass = PiCodingAgent.AuthStorage;
const PiModelRegistryClass = PiCodingAgent.ModelRegistry;

export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };

type ProviderRuntimeModelLike = Model<Api> & {
  contextTokens?: number;
};

type DiscoveredProviderRuntimeModelLike = Omit<ProviderRuntimeModelLike, "api"> & {
  api?: string | null;
};

type DiscoverModelsOptions = {
  providerFilter?: string;
  normalizeModels?: boolean;
};

type InMemoryAuthStorageBackendLike = {
  withLock<T>(
    update: (current: string) => {
      result: T;
      next?: string;
    },
  ): T;
};

function createInMemoryAuthStorageBackend(
  initialData: PiCredentialMap,
): InMemoryAuthStorageBackendLike {
  let snapshot = JSON.stringify(initialData, null, 2);
  return {
    withLock<T>(
      update: (current: string) => {
        result: T;
        next?: string;
      },
    ): T {
      const { result, next } = update(snapshot);
      if (typeof next === "string") {
        snapshot = next;
      }
      return result;
    },
  };
}

// Cache normalized models per (agentDir, provider, modelId) so repeated
// `registry.getAvailable()` calls don't re-load the entire plugin manifest
// registry once per model on every call. Without this, ~50 models × 3 hooks
// × ~50 plugin manifests = ~7,500 manifest open+stat+close cycles per
// `getAvailable()` call, which is invoked from `ensureContextWindowCacheLoaded`
// (`src/agents/context.ts:243`) and pegs the TUI process at 100% CPU during
// startup model resolution. See #75137.
//
// Cache invalidation: the input model object identity is the cache value
// criterion. If pi's underlying registry returns a NEW model object (e.g. after
// a refresh), we miss the cache and re-normalize. The cache is bounded by
// total unique (provider, modelId) pairs and is process-lifetime — discovered
// models are stable for a given config snapshot.
type NormalizedModelCacheKey = string;
type NormalizedModelCacheEntry = { input: unknown; output: unknown };
const NORMALIZED_MODEL_CACHE = new Map<NormalizedModelCacheKey, NormalizedModelCacheEntry>();
const MAX_NORMALIZED_MODEL_CACHE_ENTRIES = 1024;

function buildNormalizedModelCacheKey(
  agentDir: string,
  provider: string,
  modelId: string,
): NormalizedModelCacheKey {
  return `${agentDir}\0${provider}\0${modelId}`;
}

export function normalizeDiscoveredPiModel<T>(value: T, agentDir: string): T {
  if (!isRecord(value)) {
    return value;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string"
  ) {
    return value;
  }
  const model = value as unknown as DiscoveredProviderRuntimeModelLike;
  const cacheKey = buildNormalizedModelCacheKey(agentDir, model.provider, model.id);
  const cached = NORMALIZED_MODEL_CACHE.get(cacheKey);
  if (cached && cached.input === value) {
    return cached.output as T;
  }
  const pluginNormalized =
    normalizeProviderResolvedModelWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: model as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? model;
  const compatNormalized =
    applyProviderResolvedModelCompatWithPlugins({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: pluginNormalized as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? pluginNormalized;
  const transportNormalized =
    applyProviderResolvedTransportWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: compatNormalized as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? compatNormalized;
  if (
    !isRecord(transportNormalized) ||
    typeof transportNormalized.id !== "string" ||
    typeof transportNormalized.name !== "string" ||
    typeof transportNormalized.provider !== "string" ||
    typeof transportNormalized.api !== "string"
  ) {
    return value;
  }
  const result = normalizeModelCompat(transportNormalized as Model<Api>) as T;
  if (NORMALIZED_MODEL_CACHE.size >= MAX_NORMALIZED_MODEL_CACHE_ENTRIES) {
    // Bounded cache: evict oldest entry (FIFO via Map insertion order).
    const oldestKey = NORMALIZED_MODEL_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      NORMALIZED_MODEL_CACHE.delete(oldestKey);
    }
  }
  NORMALIZED_MODEL_CACHE.set(cacheKey, { input: value, output: result });
  return result;
}

/** Test seam: clear the normalized-model cache between scenarios. */
export function resetNormalizeDiscoveredPiModelCacheForTest(): void {
  NORMALIZED_MODEL_CACHE.clear();
}

type PiModelRegistryClassLike = {
  create?: (authStorage: PiAuthStorage, modelsJsonPath: string) => PiModelRegistry;
  new (authStorage: PiAuthStorage, modelsJsonPath: string): PiModelRegistry;
};

function instantiatePiModelRegistry(
  authStorage: PiAuthStorage,
  modelsJsonPath: string,
): PiModelRegistry {
  const Registry = PiModelRegistryClass as unknown as PiModelRegistryClassLike;
  if (typeof Registry.create === "function") {
    return Registry.create(authStorage, modelsJsonPath);
  }
  return new Registry(authStorage, modelsJsonPath);
}

function createOpenClawModelRegistry(
  authStorage: PiAuthStorage,
  modelsJsonPath: string,
  agentDir: string,
  options?: DiscoverModelsOptions,
): PiModelRegistry {
  const registry = instantiatePiModelRegistry(authStorage, modelsJsonPath);
  const getAll = registry.getAll.bind(registry);
  const getAvailable = registry.getAvailable.bind(registry);
  const find = registry.find.bind(registry);
  const providerFilter = options?.providerFilter ? normalizeProviderId(options.providerFilter) : "";
  const matchesProviderFilter = (entry: Model<Api>) =>
    !providerFilter || normalizeProviderId(entry.provider) === providerFilter;
  const shouldNormalize = options?.normalizeModels !== false;

  registry.getAll = () => {
    const entries = getAll().filter((entry: Model<Api>) => matchesProviderFilter(entry));
    return shouldNormalize
      ? entries.map((entry: Model<Api>) => normalizeDiscoveredPiModel(entry, agentDir))
      : entries;
  };
  registry.getAvailable = () => {
    const entries = getAvailable().filter((entry: Model<Api>) => matchesProviderFilter(entry));
    return shouldNormalize
      ? entries.map((entry: Model<Api>) => normalizeDiscoveredPiModel(entry, agentDir))
      : entries;
  };
  registry.find = (provider: string, modelId: string) =>
    shouldNormalize
      ? normalizeDiscoveredPiModel(find(provider, modelId), agentDir)
      : find(provider, modelId);

  return registry;
}

function createAuthStorage(AuthStorageLike: unknown, path: string, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as PiAuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backendCtor = (
      PiCodingAgent as { InMemoryAuthStorageBackend?: new () => InMemoryAuthStorageBackendLike }
    ).InMemoryAuthStorageBackend;
    const backend =
      typeof backendCtor === "function"
        ? new backendCtor()
        : createInMemoryAuthStorageBackend(creds);
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify(creds, null, 2),
    }));
    return withFromStorage.fromStorage(backend) as PiAuthStorage;
  }

  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  const withRuntimeOverride = (
    typeof withFactory.create === "function"
      ? withFactory.create(path)
      : new (AuthStorageLike as { new (path: string): unknown })(path)
  ) as PiAuthStorage & {
    setRuntimeApiKey?: (provider: string, apiKey: string) => void; // pragma: allowlist secret
  };
  const hasRuntimeApiKeyOverride = typeof withRuntimeOverride.setRuntimeApiKey === "function"; // pragma: allowlist secret
  if (hasRuntimeApiKeyOverride) {
    for (const [provider, credential] of Object.entries(creds)) {
      if (credential.type === "api_key") {
        withRuntimeOverride.setRuntimeApiKey(provider, credential.key);
        continue;
      }
      withRuntimeOverride.setRuntimeApiKey(provider, credential.access);
    }
  }
  return withRuntimeOverride;
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): PiAuthStorage {
  const credentials =
    options?.skipCredentials === true ? {} : resolvePiCredentialsForDiscovery(agentDir, options);
  const authPath = path.join(agentDir, "auth.json");
  if (options?.readOnly !== true) {
    scrubLegacyStaticAuthJsonEntriesForDiscovery(authPath);
  }
  return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}

export function discoverModels(
  authStorage: PiAuthStorage,
  agentDir: string,
  options?: DiscoverModelsOptions,
): PiModelRegistry {
  return createOpenClawModelRegistry(
    authStorage,
    path.join(agentDir, "models.json"),
    agentDir,
    options,
  );
}

export {
  addEnvBackedPiCredentials,
  resolvePiCredentialsForDiscovery,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./pi-auth-discovery.js";
