import { join } from "node:path";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { getAgentDir } from "../config.js";
import { resolveModelPluginMetadataSnapshot } from "../model-discovery-context.js";
import type {
  PersistedPluginModelCatalog,
  PluginModelCatalogMetadataSnapshot,
} from "../plugin-model-catalog.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import type { AuthStatus, AuthStorage } from "./auth-storage.js";
import {
  buildModelRegistryCatalog,
  type ModelRegistryCatalogOptions,
} from "./model-registry-catalog.js";
import {
  getModelRegistryProviderRequestConfig,
  resolveModelRegistryRequestAuth,
  hasModelRegistryConfiguredAuth,
  resolveModelRegistryProviderApiKey,
} from "./model-registry-request-auth.js";
import { createRegistryRuntimeModel } from "./model-registry-runtime-model.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
  resetModelRegistryRuntime,
} from "./model-registry-runtime.js";
import { validateModelRegistryProviderModels } from "./model-registry-schema.js";
import {
  cloneMapValues,
  storeModelRegistryProviderRequestConfig,
  storeModelRegistryHeaders,
  type ProviderRequestConfig,
  readModelRegistryPluginCatalogs,
  type ResolvedRequestAuth,
} from "./model-registry-sources.js";
import type { ProviderConfigInput } from "./provider-config.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.js";

export type { ProviderConfigInput } from "./provider-config.js";
export type { ResolvedRequestAuth } from "./model-registry-sources.js";

type ModelRegistryOptions = ModelRegistryCatalogOptions & {
  sourceSnapshot?: ModelRegistry;
  workspaceDir?: string;
};

type ModelRegistryCatalogSnapshot = {
  models: Model[];
  providerRequestConfigs: Map<string, ProviderRequestConfig>;
  modelRequestHeaders: Map<string, Record<string, string>>;
  loadError: string | undefined;
  pluginMetadataSnapshot: PluginModelCatalogMetadataSnapshot | undefined;
  oauthProviders: OAuthProviderInterface[];
};

export class ModelRegistry {
  private models: Model[] = [];
  private config: OpenClawConfig | undefined;
  private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
  private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
  private registeredProviders: Map<string, ProviderConfigInput> = new Map();
  private loadError: string | undefined = undefined;
  readonly authStorage: AuthStorage;
  private modelsJsonPath: string | undefined;
  private modelsJsonContents: string | null | undefined;
  private pluginCatalogs: readonly PersistedPluginModelCatalog[] | undefined;
  private pluginCatalogReadError: string | undefined;
  private readonly reloadPluginCatalogs: boolean;
  private staticProviderConfigs: Readonly<Record<string, ModelProviderConfig>> | undefined;
  private pluginMetadataSnapshot: PluginModelCatalogMetadataSnapshot | undefined;
  private includePluginCatalogs = true;
  private baseCatalogSnapshot: ModelRegistryCatalogSnapshot | undefined;
  private sourceSnapshot: ModelRegistryCatalogSnapshot | undefined;

  private constructor(
    authStorage: AuthStorage,
    modelsJsonPath: string | undefined,
    options: ModelRegistryOptions = {},
    publishedModels?: ReadonlyMap<string, readonly Model[]>,
    preparedCatalogs?: { catalogs: readonly PersistedPluginModelCatalog[]; error?: string },
  ) {
    this.authStorage = authStorage;
    this.config = options.config ?? options.sourceSnapshot?.config;
    this.includePluginCatalogs = options.includePluginCatalogs !== false;
    this.reloadPluginCatalogs = this.includePluginCatalogs && options.pluginCatalogs === undefined;
    initializeModelRegistryRuntime(this);
    if (options.sourceSnapshot) {
      const source = options.sourceSnapshot;
      const captured = source.baseCatalogSnapshot ?? source.captureCatalogSnapshot();
      const sourceSnapshot = publishedModels
        ? {
            ...captured,
            models: [
              ...captured.models.filter((model) => !publishedModels.has(model.provider)),
              ...[...publishedModels.values()].flat(),
            ],
          }
        : captured;
      this.sourceSnapshot = sourceSnapshot;
      this.baseCatalogSnapshot = sourceSnapshot;
      this.restoreSourceCatalog(sourceSnapshot);
      this.registeredProviders = cloneMapValues(source.registeredProviders);
      getAuthStorageOAuthProviderRegistry(authStorage).reset();
      for (const oauthProvider of sourceSnapshot.oauthProviders) {
        getAuthStorageOAuthProviderRegistry(authStorage).register(oauthProvider);
      }
      for (const [providerName, config] of this.registeredProviders.entries()) {
        this.applyProviderConfig(providerName, config);
      }
      return;
    }
    this.modelsJsonPath = modelsJsonPath;
    this.modelsJsonContents = options.modelsJsonContents;
    this.pluginCatalogs = preparedCatalogs?.catalogs ?? options.pluginCatalogs;
    this.pluginCatalogReadError = preparedCatalogs?.error;
    this.staticProviderConfigs = options.staticProviderConfigs;
    this.pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
      config: this.config,
      ...(options.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: options.pluginMetadataSnapshot }
        : {}),
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      allowWorkspaceScopedCurrent: true,
    });
    this.loadModels();
    this.baseCatalogSnapshot = this.captureCatalogSnapshot();
  }

  private captureCatalogSnapshot(): ModelRegistryCatalogSnapshot {
    return {
      models: structuredClone(this.models),
      providerRequestConfigs: cloneMapValues(this.providerRequestConfigs),
      modelRequestHeaders: cloneMapValues(this.modelRequestHeaders),
      loadError: this.loadError,
      pluginMetadataSnapshot: this.pluginMetadataSnapshot,
      oauthProviders: [...this.authStorage.getOAuthProviders()],
    };
  }

  private restoreSourceCatalog(source: ModelRegistryCatalogSnapshot): void {
    this.models = structuredClone(source.models);
    this.providerRequestConfigs = cloneMapValues(source.providerRequestConfigs);
    this.modelRequestHeaders = cloneMapValues(source.modelRequestHeaders);
    this.loadError = source.loadError;
    this.pluginMetadataSnapshot = source.pluginMetadataSnapshot;
  }

  /** @deprecated Use createAsync or fromCapturedSources. Supported through 2026-12-31; removal ships in the first January 2027 stable release. */
  static create(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): ModelRegistry {
    if (options.pluginCatalogs === undefined && options.includePluginCatalogs !== false) {
      ModelRegistry.warnNativeCatalogRead("ModelRegistry.create", "ModelRegistry.createAsync");
    }
    return new ModelRegistry(authStorage, modelsJsonPath, options);
  }

  /** Read persisted plugin catalogs through their worker before publishing the registry. */
  static async createAsync(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): Promise<ModelRegistry> {
    const prepared =
      options.pluginCatalogs === undefined && options.includePluginCatalogs !== false
        ? await readModelRegistryPluginCatalogs(modelsJsonPath, options)
        : undefined;
    return new ModelRegistry(authStorage, modelsJsonPath, options, undefined, prepared);
  }

  /** Parse owner-prepared catalogs without opening their persistence store. */
  static fromCapturedSources(
    authStorage: AuthStorage,
    modelsJsonPath: string,
    options: ModelRegistryOptions & { pluginCatalogs: readonly PersistedPluginModelCatalog[] },
  ): ModelRegistry {
    return new ModelRegistry(authStorage, modelsJsonPath, options);
  }

  private static warnNativeCatalogRead(method: string, replacement: string): void {
    warnPluginSdkDeprecation({ family: "model-registry-native-read", method, replacement });
  }

  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  /** Creates a request-isolated registry from this lifecycle-owned catalog snapshot. */
  fork(
    authStorage: AuthStorage,
    publishedModels?: ReadonlyMap<string, readonly Model[]>,
  ): ModelRegistry {
    return new ModelRegistry(authStorage, undefined, { sourceSnapshot: this }, publishedModels);
  }

  /** @deprecated Await refreshAsync for disk-backed catalogs. Supported through 2026-12-31; removal ships in the first January 2027 stable release. */
  refresh(): void {
    if (this.reloadPluginCatalogs && this.modelsJsonPath) {
      ModelRegistry.warnNativeCatalogRead("ModelRegistry.refresh", "ModelRegistry.refreshAsync");
    }
    this.refreshFromStorage();
  }

  private refreshFromStorage(): void {
    if (this.reloadPluginCatalogs && this.modelsJsonPath) {
      // Legacy SDK callers retain synchronous disk freshness through 2026-12-31.
      this.pluginCatalogs = undefined;
      this.pluginCatalogReadError = undefined;
    }
    this.reload();
  }

  async refreshAsync(): Promise<void> {
    if (this.reloadPluginCatalogs && this.modelsJsonPath) {
      const prepared = await readModelRegistryPluginCatalogs(this.modelsJsonPath, {
        config: this.config,
        modelsJsonContents: this.modelsJsonContents,
      });
      this.pluginCatalogs = prepared.catalogs;
      this.pluginCatalogReadError = prepared.error;
    }
    this.reload();
  }

  private reload(): void {
    this.providerRequestConfigs.clear();
    this.modelRequestHeaders.clear();
    this.loadError = undefined;

    // Rebuild this lifecycle's API/OAuth registrations from current provider state.
    resetModelRegistryRuntime(this);
    getAuthStorageOAuthProviderRegistry(this.authStorage).reset();

    if (this.sourceSnapshot) {
      this.restoreSourceCatalog(this.sourceSnapshot);
      for (const oauthProvider of this.sourceSnapshot.oauthProviders) {
        getAuthStorageOAuthProviderRegistry(this.authStorage).register(oauthProvider);
      }
    } else {
      this.loadModels();
      // Forks start from the latest disk-backed base, then replay this registry's dynamic providers.
      this.baseCatalogSnapshot = this.captureCatalogSnapshot();
    }

    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }

  /** Get any root or generated plugin catalog load error. */
  getError(): string | undefined {
    return this.loadError;
  }

  /** Returns the exact plugin metadata generation captured with this registry. */
  getProviderMetadataOwners() {
    return this.pluginMetadataSnapshot?.owners;
  }

  private loadModels(): void {
    const catalog = buildModelRegistryCatalog(this.authStorage, this.modelsJsonPath, {
      config: this.config,
      includePluginCatalogs: this.includePluginCatalogs,
      modelsJsonContents: this.modelsJsonContents,
      pluginCatalogs: this.pluginCatalogs,
      pluginCatalogReadError: this.pluginCatalogReadError,
      staticProviderConfigs: this.staticProviderConfigs,
      pluginMetadataSnapshot: this.pluginMetadataSnapshot,
      inspectLegacyCatalogs: this.reloadPluginCatalogs,
    });
    this.models = catalog.models;
    this.providerRequestConfigs = catalog.providerRequestConfigs;
    this.modelRequestHeaders = catalog.modelRequestHeaders;
    this.loadError = catalog.loadError;
  }

  getAll(): Model[] {
    return this.models;
  }

  /**
   * Get only models that have auth configured.
   * This is a fast check that doesn't refresh OAuth tokens.
   */
  getAvailable(): Model[] {
    return this.models.filter((m) => this.hasConfiguredAuth(m));
  }

  find(provider: string, modelId: string): Model | undefined {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  hasConfiguredAuth(model: Model): boolean {
    return hasModelRegistryConfiguredAuth({
      model,
      providerConfig: getModelRegistryProviderRequestConfig(model, this.providerRequestConfigs),
      authStorage: this.authStorage,
    });
  }

  async getApiKeyAndHeaders(model: Model): Promise<ResolvedRequestAuth> {
    return resolveModelRegistryRequestAuth({
      model,
      providerConfig: getModelRegistryProviderRequestConfig(model, this.providerRequestConfigs),
      modelHeaders: this.modelRequestHeaders.get(JSON.stringify([model.provider, model.id])),
      authStorage: this.authStorage,
    });
  }

  /**
   * Return auth status for a provider, including request auth configured in models.json.
   * This intentionally does not execute command-backed config values.
   */
  getProviderAuthStatus(provider: string): AuthStatus {
    const providerRequestConfig = this.providerRequestConfigs.get(provider);
    if (providerRequestConfig?.auth === "aws-sdk") {
      return { configured: true, source: "models_json_key", label: providerRequestConfig.auth };
    }

    const authStatus = this.authStorage.getAuthStatus(provider);
    if (authStatus.source) {
      return authStatus;
    }

    const providerApiKey = providerRequestConfig?.apiKey;
    if (!providerApiKey) {
      return authStatus;
    }

    if (providerApiKey.startsWith("!")) {
      return { configured: true, source: "models_json_command" };
    }

    if (process.env[providerApiKey]) {
      return { configured: true, source: "environment", label: providerApiKey };
    }

    return { configured: true, source: "models_json_key" };
  }

  getProviderDisplayName(provider: string): string {
    const registeredProvider = this.registeredProviders.get(provider);
    const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === provider);

    return (
      registeredProvider?.name ??
      registeredProvider?.oauth?.name ??
      oauthProvider?.name ??
      BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
      provider
    );
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    return resolveModelRegistryProviderApiKey({
      provider,
      readProviderConfig: () => this.providerRequestConfigs.get(provider),
      authStorage: this.authStorage,
    });
  }

  isUsingOAuth(model: Model): boolean {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === "oauth";
  }

  /**
   * Register a provider dynamically (from extensions).
   *
   * If provider has models: replaces all existing models for this provider.
   * Provider-level request settings are stored for already-known models but
   * never create implicit model rows.
   * If provider has oauth: registers OAuth provider for /login support.
   */
  registerProvider(providerName: string, config: ProviderConfigInput): void {
    if (config.streamSimple && !config.api) {
      throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
    }
    validateModelRegistryProviderModels(providerName, config, "registration");
    this.applyProviderConfig(providerName, config);
    const existing = this.registeredProviders.get(providerName);
    if (!existing) {
      this.registeredProviders.set(providerName, config);
      return;
    }
    // Undefined registration fields preserve the stored provider configuration.
    for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
      if (config[k] !== undefined) {
        (existing as Record<string, unknown>)[k] = config[k];
      }
    }
  }

  /**
   * Unregister a previously registered provider.
   *
   * Removes the provider from the registry and reloads models from disk.
   * Also resets dynamic OAuth and API stream registrations before reapplying
   * remaining dynamic providers.
   * Has no effect if the provider was never registered.
   * @deprecated Use unregisterProviderAsync for disk-backed registries. Supported through 2026-12-31; removal ships in the first January 2027 stable release.
   */
  unregisterProvider(providerName: string): void {
    if (this.reloadPluginCatalogs && this.modelsJsonPath) {
      ModelRegistry.warnNativeCatalogRead(
        "ModelRegistry.unregisterProvider",
        "ModelRegistry.unregisterProviderAsync",
      );
    }
    if (!this.registeredProviders.delete(providerName)) {
      return;
    }
    this.refreshFromStorage();
  }

  async unregisterProviderAsync(providerName: string): Promise<void> {
    if (!this.registeredProviders.delete(providerName)) {
      return;
    }
    await this.refreshAsync();
  }

  private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.oauth) {
      const oauthProvider: OAuthProviderInterface = {
        ...config.oauth,
        id: providerName,
      };
      getAuthStorageOAuthProviderRegistry(this.authStorage).register(oauthProvider);
    }

    if (config.streamSimple) {
      const streamSimple = config.streamSimple;
      getModelRegistryRuntime(this).apiRegistry.registerApiProvider(
        {
          api: config.api!,
          stream: (model, context, options) =>
            streamSimple(model, context, options as SimpleStreamOptions),
          streamSimple,
        },
        `provider:${providerName}`,
      );
    }

    storeModelRegistryProviderRequestConfig(this.providerRequestConfigs, providerName, config);

    if (config.models && config.models.length > 0) {
      this.models = this.models.filter((m) => m.provider !== providerName);

      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        storeModelRegistryHeaders(
          this.modelRequestHeaders,
          providerName,
          modelDef.id,
          modelDef.headers,
        );

        this.models.push(createRegistryRuntimeModel(providerName, config, modelDef, api));
      }

      if (config.oauth?.modifyModels) {
        const cred = this.authStorage.get(providerName);
        if (cred?.type === "oauth") {
          this.models = config.oauth.modifyModels(this.models, cred);
        }
      }
    }
  }
}
