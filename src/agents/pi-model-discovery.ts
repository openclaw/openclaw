import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
} from "../plugins/provider-runtime.js";
import { isRecord } from "../utils.js";
import { readStoredModelsConfigRaw } from "./models-config-store.js";
import type { Api, Model } from "./pi-ai-contract.js";
import type { PiCredentialMap } from "./pi-auth-credentials.js";
import {
  resolvePiCredentialsForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./pi-auth-discovery.js";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "./pi-coding-agent-contract.js";
import * as PiCodingAgent from "./pi-coding-agent-contract.js";
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
  create?: (authStorage: PiAuthStorage, modelCatalogPath?: string) => PiModelRegistry;
  inMemory?: (authStorage: PiAuthStorage) => PiModelRegistry;
  new (authStorage: PiAuthStorage, modelCatalogPath?: string): PiModelRegistry;
};

type PiProviderModelInput = {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: unknown;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
};

type PiProviderConfigInput = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: PiProviderModelInput[];
};

type ProviderConfigRecord = Record<string, unknown> & {
  models?: unknown[];
  modelOverrides?: Record<string, unknown>;
};

type PiModelRegistryWithProviderRegistration = PiModelRegistry & {
  registerProvider?: (providerName: string, config: PiProviderConfigInput) => void;
};

function instantiatePiModelRegistry(
  authStorage: PiAuthStorage,
  modelCatalogPath?: string,
): PiModelRegistry {
  const Registry = PiModelRegistryClass as unknown as PiModelRegistryClassLike;
  if (typeof Registry.create === "function") {
    return Registry.create(authStorage, modelCatalogPath);
  }
  return new Registry(authStorage, modelCatalogPath);
}

function instantiateInMemoryPiModelRegistry(authStorage: PiAuthStorage): PiModelRegistry {
  const Registry = PiModelRegistryClass as unknown as PiModelRegistryClassLike;
  if (typeof Registry.inMemory === "function") {
    return Registry.inMemory(authStorage);
  }
  return instantiatePiModelRegistry(authStorage, undefined);
}

function normalizePiApi(value: unknown): Api | undefined {
  return typeof value === "string" && value.trim() ? (value as Api) : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    typeof entry === "string" ? [[key, entry] as const] : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizePiCost(value: unknown): PiProviderModelInput["cost"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    input: typeof record.input === "number" && Number.isFinite(record.input) ? record.input : 0,
    output: typeof record.output === "number" && Number.isFinite(record.output) ? record.output : 0,
    cacheRead:
      typeof record.cacheRead === "number" && Number.isFinite(record.cacheRead)
        ? record.cacheRead
        : 0,
    cacheWrite:
      typeof record.cacheWrite === "number" && Number.isFinite(record.cacheWrite)
        ? record.cacheWrite
        : 0,
  };
}

function normalizePiInput(value: unknown): ("text" | "image")[] {
  if (!Array.isArray(value)) {
    return ["text"];
  }
  const input = value.filter(
    (entry): entry is "text" | "image" => entry === "text" || entry === "image",
  );
  return input.length > 0 ? input : ["text"];
}

function normalizeProviderModels(value: unknown): PiProviderModelInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const models = value.flatMap((entry): PiProviderModelInput[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      return [];
    }
    const contextWindow =
      typeof record.contextWindow === "number" && record.contextWindow > 0
        ? record.contextWindow
        : 128_000;
    const maxTokens =
      typeof record.maxTokens === "number" && record.maxTokens > 0 ? record.maxTokens : 16_384;
    return [
      {
        id,
        name: typeof record.name === "string" && record.name.trim() ? record.name : id,
        ...(normalizePiApi(record.api) ? { api: normalizePiApi(record.api) } : {}),
        ...(typeof record.baseUrl === "string" && record.baseUrl.trim()
          ? { baseUrl: record.baseUrl }
          : {}),
        reasoning: typeof record.reasoning === "boolean" ? record.reasoning : false,
        ...(record.thinkingLevelMap !== undefined
          ? { thinkingLevelMap: record.thinkingLevelMap }
          : {}),
        input: normalizePiInput(record.input),
        cost: normalizePiCost(record.cost),
        contextWindow,
        maxTokens,
        ...(normalizeStringRecord(record.headers)
          ? { headers: normalizeStringRecord(record.headers) }
          : {}),
        ...(record.compat && typeof record.compat === "object"
          ? { compat: record.compat as Model<Api>["compat"] }
          : {}),
      },
    ];
  });
  return models.length > 0 ? models : undefined;
}

function normalizeProviderConfigInput(config: ProviderConfigRecord): PiProviderConfigInput {
  return {
    ...(typeof config.name === "string" && config.name.trim() ? { name: config.name } : {}),
    ...(typeof config.baseUrl === "string" && config.baseUrl.trim()
      ? { baseUrl: config.baseUrl }
      : {}),
    ...(typeof config.apiKey === "string" && config.apiKey.trim() ? { apiKey: config.apiKey } : {}),
    ...(normalizePiApi(config.api) ? { api: normalizePiApi(config.api) } : {}),
    ...(normalizeStringRecord(config.headers)
      ? { headers: normalizeStringRecord(config.headers) }
      : {}),
    ...(typeof config.authHeader === "boolean" ? { authHeader: config.authHeader } : {}),
    ...(normalizeProviderModels(config.models)
      ? { models: normalizeProviderModels(config.models) }
      : {}),
  };
}

export function applyStoredModelsConfigToRegistry(
  registry: PiModelRegistry,
  agentDir: string,
): void {
  const withProviderRegistration = registry as PiModelRegistryWithProviderRegistration;
  if (typeof withProviderRegistration.registerProvider !== "function") {
    return;
  }
  const stored = readStoredModelsConfigRaw(agentDir);
  if (!stored) {
    return;
  }
  const parsed = JSON.parse(stored.raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const providers = (parsed as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return;
  }
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
      continue;
    }
    withProviderRegistration.registerProvider(
      normalizeProviderId(providerName),
      normalizeProviderConfigInput(providerConfig as ProviderConfigRecord),
    );
  }
}

function createOpenClawModelRegistry(
  authStorage: PiAuthStorage,
  agentDir: string,
  options?: DiscoverModelsOptions,
): PiModelRegistry {
  const registry = instantiateInMemoryPiModelRegistry(authStorage);
  applyStoredModelsConfigToRegistry(registry, agentDir);
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

function createAuthStorage(AuthStorageLike: unknown, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as PiAuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backendCtor = Reflect.get(PiCodingAgent, "InMemoryAuthStorageBackend") as
      | (new () => InMemoryAuthStorageBackendLike)
      | undefined;
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

  throw new Error("pi-coding-agent AuthStorage must support in-memory credentials");
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): PiAuthStorage {
  const credentials =
    options?.skipCredentials === true ? {} : resolvePiCredentialsForDiscovery(agentDir, options);
  return createAuthStorage(PiAuthStorageClass, credentials);
}

export function discoverModels(
  authStorage: PiAuthStorage,
  agentDir: string,
  options?: DiscoverModelsOptions,
): PiModelRegistry {
  return createOpenClawModelRegistry(authStorage, agentDir, options);
}

export {
  addEnvBackedPiCredentials,
  resolvePiCredentialsForDiscovery,
  type DiscoverAuthStorageOptions,
} from "./pi-auth-discovery.js";
