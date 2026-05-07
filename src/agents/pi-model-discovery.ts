import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";
import { isRecord } from "../utils.js";
import { isSecretRefHeaderValueMarker } from "./model-auth-markers.js";
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

type ModelCatalogHeaderConfig = {
  providerHeaders: Map<string, Record<string, string>>;
  modelHeaders: Map<string, Record<string, string>>;
};

type InMemoryAuthStorageBackendLike = {
  withLock<T>(
    update: (current: string) => {
      result: T;
      next?: string;
    },
  ): T;
};

const FORBIDDEN_MODEL_CATALOG_HEADER_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function normalizeModelCatalogHeaderKey(key: string): string {
  return key.trim().toLowerCase();
}

function getModelCatalogHeaderKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}

function mergeStaticModelCatalogHeaders(
  ...headerSets: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  let merged: Record<string, string> | undefined;
  const headerNamesByLowerKey = new Map<string, string>();
  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }
    merged ??= {};
    for (const [key, value] of Object.entries(headers)) {
      const normalizedKey = normalizeModelCatalogHeaderKey(key);
      if (!normalizedKey || FORBIDDEN_MODEL_CATALOG_HEADER_KEYS.has(normalizedKey)) {
        continue;
      }
      const previousKey = headerNamesByLowerKey.get(normalizedKey);
      if (previousKey && previousKey !== key) {
        delete merged[previousKey];
      }
      merged[key] = value;
      headerNamesByLowerKey.set(normalizedKey, key);
    }
  }
  return merged && Object.keys(merged).length > 0 ? merged : undefined;
}

function readStaticModelCatalogHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  let headers: Record<string, string> | undefined;
  const headerNamesByLowerKey = new Map<string, string>();
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string" || isSecretRefHeaderValueMarker(headerValue)) {
      continue;
    }
    const normalizedKey = normalizeModelCatalogHeaderKey(key);
    if (!normalizedKey || FORBIDDEN_MODEL_CATALOG_HEADER_KEYS.has(normalizedKey)) {
      continue;
    }
    headers ??= {};
    const previousKey = headerNamesByLowerKey.get(normalizedKey);
    if (previousKey && previousKey !== key) {
      delete headers[previousKey];
    }
    headers[key] = headerValue;
    headerNamesByLowerKey.set(normalizedKey, key);
  }
  return headers && Object.keys(headers).length > 0 ? headers : undefined;
}

function readModelCatalogHeaderConfig(
  modelsJsonPath: string,
): ModelCatalogHeaderConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    return undefined;
  }
  const providerHeaders = new Map<string, Record<string, string>>();
  const modelHeaders = new Map<string, Record<string, string>>();
  for (const [provider, providerConfig] of Object.entries(parsed.providers)) {
    if (!isRecord(providerConfig)) {
      continue;
    }
    const staticProviderHeaders = readStaticModelCatalogHeaders(providerConfig.headers);
    if (staticProviderHeaders) {
      providerHeaders.set(provider, staticProviderHeaders);
    }
    const models = providerConfig.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      if (!isRecord(model) || typeof model.id !== "string") {
        continue;
      }
      const staticModelHeaders = readStaticModelCatalogHeaders(model.headers);
      if (staticModelHeaders) {
        modelHeaders.set(getModelCatalogHeaderKey(provider, model.id), staticModelHeaders);
      }
    }
  }
  return providerHeaders.size > 0 || modelHeaders.size > 0
    ? { providerHeaders, modelHeaders }
    : undefined;
}

function materializeModelCatalogHeaders<T>(
  value: T,
  config: ModelCatalogHeaderConfig | undefined,
): T {
  if (!config || !isRecord(value)) {
    return value;
  }
  if (typeof value.provider !== "string" || typeof value.id !== "string") {
    return value;
  }
  const headers = mergeStaticModelCatalogHeaders(
    readStaticModelCatalogHeaders(value.headers),
    config.providerHeaders.get(value.provider),
    config.modelHeaders.get(getModelCatalogHeaderKey(value.provider, value.id)),
  );
  return headers ? ({ ...value, headers } as T) : value;
}

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
  const refresh = registry.refresh.bind(registry);
  let catalogHeaderConfig = readModelCatalogHeaderConfig(modelsJsonPath);
  const providerFilter = options?.providerFilter ? normalizeProviderId(options.providerFilter) : "";
  const matchesProviderFilter = (entry: Model<Api>) =>
    !providerFilter || normalizeProviderId(entry.provider) === providerFilter;
  const shouldNormalize = options?.normalizeModels !== false;
  const findCache = new Map<string, Model<Api> | undefined>();
  const prepareEntry = (entry: Model<Api>) => {
    const materialized = materializeModelCatalogHeaders(entry, catalogHeaderConfig);
    return shouldNormalize ? normalizeDiscoveredPiModel(materialized, agentDir) : materialized;
  };

  registry.getAll = () => {
    const entries = getAll().filter((entry: Model<Api>) => matchesProviderFilter(entry));
    return entries.map((entry: Model<Api>) => prepareEntry(entry));
  };
  registry.getAvailable = () => {
    const entries = getAvailable().filter((entry: Model<Api>) => matchesProviderFilter(entry));
    return entries.map((entry: Model<Api>) => prepareEntry(entry));
  };
  registry.find = (provider: string, modelId: string) => {
    const normalizedProvider = normalizeProviderId(provider);
    const key = `${normalizedProvider}\0${modelId}`;
    if (findCache.has(key)) {
      return findCache.get(key);
    }
    const fallbackEntry = find(provider, modelId);
    const resolved = fallbackEntry ? prepareEntry(fallbackEntry) : undefined;
    findCache.set(key, resolved);
    return resolved;
  };
  registry.refresh = () => {
    findCache.clear();
    catalogHeaderConfig = readModelCatalogHeaderConfig(modelsJsonPath);
    return refresh();
  };

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
