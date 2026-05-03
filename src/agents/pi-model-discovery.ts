import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";
import { isRecord } from "../utils.js";
import { resolveAuthStatePath, resolveAuthStorePath } from "./auth-profiles/paths.js";
import type { PiCredentialMap } from "./pi-auth-credentials.js";
import {
  resolvePiCredentialsForDiscovery,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./pi-auth-discovery.js";
import { normalizeProviderId } from "./provider-id.js";
import { stableStringify } from "./stable-stringify.js";

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
  config?: OpenClawConfig;
};

type FileFingerprint = { mtimeMs: number | null; size: number | null };

const PI_DISCOVERY_CACHE_LIMIT = 64;
const piDiscoveryCache = new Map<string, PiModelRegistry>();

function fileFingerprint(filePath: string): FileFingerprint {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: null, size: null };
  }
}

function buildPiDiscoveryCacheKey(params: {
  agentDir: string;
  modelsJsonPath: string;
  options?: DiscoverModelsOptions;
}): string {
  const provider = params.options?.providerFilter
    ? normalizeProviderId(params.options.providerFilter)
    : "";
  const mainAuthPath = resolveAuthStorePath();
  const agentAuthPath = resolveAuthStorePath(params.agentDir);
  return stableStringify({
    version: 2,
    agentDir: path.resolve(params.agentDir),
    provider,
    normalizeModels: params.options?.normalizeModels !== false,
    config: {
      models: params.options?.config?.models ?? null,
      plugins: params.options?.config?.plugins ?? null,
    },
    auth: {
      main: fileFingerprint(mainAuthPath),
      mainState: fileFingerprint(resolveAuthStatePath()),
      agent: fileFingerprint(agentAuthPath),
      agentState: fileFingerprint(resolveAuthStatePath(params.agentDir)),
    },
    modelsJson: fileFingerprint(params.modelsJsonPath),
  });
}

function readCachedPiDiscovery(key: string): PiModelRegistry | undefined {
  if (process.env.OPENCLAW_DISABLE_MODEL_DISCOVERY_CACHE === "1") {
    return undefined;
  }
  const cached = piDiscoveryCache.get(key);
  if (!cached) {
    return undefined;
  }
  piDiscoveryCache.delete(key);
  piDiscoveryCache.set(key, cached);
  return cached;
}

function writeCachedPiDiscovery(key: string, registry: PiModelRegistry): void {
  if (process.env.OPENCLAW_DISABLE_MODEL_DISCOVERY_CACHE === "1") {
    return;
  }
  if (piDiscoveryCache.has(key)) {
    piDiscoveryCache.delete(key);
  }
  piDiscoveryCache.set(key, registry);
  while (piDiscoveryCache.size > PI_DISCOVERY_CACHE_LIMIT) {
    const oldest = piDiscoveryCache.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    piDiscoveryCache.delete(oldest);
  }
}

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
  return normalizeModelCompat(transportNormalized as Model<Api>) as T;
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
  const modelsJsonPath = path.join(agentDir, "models.json");
  const cacheKey = buildPiDiscoveryCacheKey({ agentDir, modelsJsonPath, options });
  const cached = readCachedPiDiscovery(cacheKey);
  if (cached) {
    return cached;
  }
  const registry = createOpenClawModelRegistry(authStorage, modelsJsonPath, agentDir, options);
  writeCachedPiDiscovery(cacheKey, registry);
  return registry;
}

export {
  addEnvBackedPiCredentials,
  resolvePiCredentialsForDiscovery,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./pi-auth-discovery.js";
