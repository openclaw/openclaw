import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model, SimpleStreamOptions } from "../../llm/types.js";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import { getAgentDir } from "../config.js";
import { sanitizeModelHeaders } from "../embedded-agent-runner/model.inline-provider.js";
import { hasUsableCustomProviderApiKey } from "../model-auth-provider-config.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "../model-auth-runtime-config.js";
import { parseModelCatalogJson } from "../model-catalog-json.js";
import { modelTransportRoutesMatch } from "../model-compat-catalog.js";
import { resolveModelPluginMetadataSnapshot } from "../model-discovery-context.js";
import {
  buildSourceModelFields,
  mergeProviderModels,
  normalizeProviderMapKeys,
  type ProviderModelCatalog,
} from "../models-config.merge.js";
import { materializeConfiguredProviderCatalogModels } from "../models-config.providers.catalog.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  isGeneratedPluginModelCatalog,
  inspectLegacyPluginModelCatalogs,
  loadPersistedPluginModelCatalogsReadOnly,
  type PersistedPluginModelCatalog,
  type PluginModelCatalogMetadataSnapshot,
} from "../plugin-model-catalog.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import type { AuthStatus, AuthStorage } from "./auth-storage.js";
import {
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
import {
  formatValidationPath,
  omitInvalidModelCosts,
  validateModelsConfig,
  type ProviderAuthMode,
} from "./model-registry-schema.js";
import {
  captureProviderSource,
  cloneMapValues,
  emptyCustomModelsResult,
  type ProviderRequestConfig,
  type CustomModelsResult,
  readModelRegistryPluginCatalogs,
  type RegistryProviderSources,
  type ResolvedRequestAuth,
} from "./model-registry-sources.js";
import type { ProviderConfigInput } from "./provider-config.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.js";

export type { ProviderConfigInput } from "./provider-config.js";
export type { ResolvedRequestAuth } from "./model-registry-sources.js";

const log = createSubsystemLogger("agents/model-registry");

type ModelRegistryOptions = {
  config?: OpenClawConfig;
  includePluginCatalogs?: boolean;
  modelsJsonContents?: string | null;
  pluginCatalogs?: readonly PersistedPluginModelCatalog[];
  staticProviderConfigs?: Readonly<Record<string, ModelProviderConfig>>;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
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
    // Keep authored models.json separate from rebuildable provider catalogs
    // owned by the agent SQLite cache.
    const replace = this.config?.models?.mode === "replace";
    const customResult =
      !replace && this.modelsJsonPath && this.modelsJsonContents !== null
        ? this.loadCustomModels(this.modelsJsonPath, {
            ...(this.modelsJsonContents !== undefined ? { contents: this.modelsJsonContents } : {}),
            includePluginCatalogs: this.includePluginCatalogs && this.pluginCatalogs === undefined,
          })
        : emptyCustomModelsResult();
    const capturedPluginResult =
      !replace && this.includePluginCatalogs && this.pluginCatalogs !== undefined
        ? this.loadCapturedPluginCatalogs(this.pluginCatalogs)
        : emptyCustomModelsResult();
    const errors = [
      customResult.error,
      capturedPluginResult.error,
      this.pluginCatalogReadError,
    ].filter((error): error is string => Boolean(error));

    if (
      !replace &&
      this.modelsJsonPath &&
      this.modelsJsonContents === undefined &&
      this.reloadPluginCatalogs &&
      this.staticProviderConfigs === undefined &&
      this.includePluginCatalogs
    ) {
      // Only explicit disk discovery/refresh inspects legacy sources; hot lookups
      // and lifecycle-captured registries consume their existing catalog snapshot.
      const inspected = inspectLegacyPluginModelCatalogs(dirname(this.modelsJsonPath));
      const diagnostics = [
        ...inspected.warnings,
        ...inspected.catalogs.map(
          ({ pathname }) => `Legacy generated provider catalog: ${pathname}`,
        ),
      ];
      if (diagnostics.length > 0) {
        errors.push(
          `${diagnostics.join("\n")}\nRun openclaw doctor --fix to verify and import legacy provider catalogs.`,
        );
      }
    }

    if (errors.length > 0) {
      this.loadError = errors.join("\n\n");
      log.warn(`model catalog load issue: ${this.loadError}`);
      // Plugin catalog failures can return salvaged models; root failures return empty.
    }

    const providers = this.mergeProviderSources(
      replace
        ? {}
        : Object.fromEntries(
            Object.entries(this.staticProviderConfigs ?? {}).map(([provider, config]) => [
              provider,
              captureProviderSource(config, "static"),
            ]),
          ),
      capturedPluginResult.providers,
      customResult.providers,
    );
    const sourceFields = buildSourceModelFields(
      materializeConfiguredProviderCatalogModels(
        this.config && projectConfigOntoRuntimeSourceSnapshot(this.config).models?.providers,
        { manifestPlugins: this.pluginMetadataSnapshot },
      ),
    );
    for (const [providerId, configured] of Object.entries(
      normalizeProviderMapKeys(
        materializeConfiguredProviderCatalogModels(this.config?.models?.providers, {
          manifestPlugins: this.pluginMetadataSnapshot,
        }),
      ),
    )) {
      const inherited = providers[providerId];
      const accepted = new Map(inherited?.models?.map((model) => [model.id, model]));
      const current: RegistryProviderSources[string] = {
        api: configured.api,
        baseUrl: configured.baseUrl,
        models: configured.models?.map((model) => ({
          ...model,
          api: model.api ?? accepted.get(model.id)?.api ?? configured.api,
          baseUrl: model.baseUrl ?? accepted.get(model.id)?.baseUrl ?? configured.baseUrl,
          maxTokensSource: "configured",
          headers: sanitizeModelHeaders(model.headers),
        })),
      };
      providers[providerId] = inherited
        ? mergeProviderModels(captureProviderSource(inherited, "composed"), current, {
            providerId,
            modelIdMatching: "exact",
            sourceModelFields: sourceFields,
          })
        : current;
      this.providerRequestConfigs.delete(providerId);
      // Current config owns provider request settings, including accepted catalog routes.
      // File-only callers retain the authored-endpoint scope captured by loadCustomModels.
      this.storeProviderRequestConfig(providerId, {
        apiKey: normalizeOptionalSecretInput(configured.apiKey),
        auth: configured.auth,
        authHeader: configured.authHeader,
        headers: sanitizeModelHeaders(configured.headers),
      });
    }
    let combined = this.parseModels(providers);

    for (const oauthProvider of this.authStorage.getOAuthProviders()) {
      const cred = this.authStorage.get(oauthProvider.id);
      if (cred?.type === "oauth" && oauthProvider.modifyModels) {
        combined = oauthProvider.modifyModels(combined, cred);
      }
    }

    this.models = combined;
  }

  private mergeProviderSources(
    ...sources: readonly RegistryProviderSources[]
  ): RegistryProviderSources {
    const providers: RegistryProviderSources = {};
    for (const source of sources) {
      for (const [providerId, provider] of Object.entries(source)) {
        const existing = providers[providerId];
        providers[providerId] = existing
          ? mergeProviderModels(existing, provider, {
              providerId,
              modelIdMatching: "exact",
            })
          : provider;
      }
    }
    return providers;
  }

  private loadCapturedPluginCatalogs(
    pluginCatalogs: readonly PersistedPluginModelCatalog[],
  ): CustomModelsResult {
    let providers: RegistryProviderSources = {};
    const errors: string[] = [];
    for (const pluginCatalog of pluginCatalogs) {
      const result = this.loadCustomModels(
        `sqlite:plugin-model-catalog/${pluginCatalog.pluginId}`,
        {
          catalogPluginId: pluginCatalog.pluginId,
          contents: pluginCatalog.contents,
          includePluginCatalogs: false,
          requireGeneratedCatalog: true,
        },
      );
      providers = this.mergeProviderSources(providers, result.providers);
      if (result.error) {
        errors.push(result.error);
      }
    }
    return { providers, error: errors.join("\n\n") || undefined };
  }

  private loadCustomModels(
    modelsJsonPath: string,
    options: {
      catalogPluginId?: string;
      contents?: string;
      includePluginCatalogs?: boolean;
      requireGeneratedCatalog?: boolean;
    } = {
      includePluginCatalogs: true,
    },
  ): CustomModelsResult {
    if (options.contents === undefined && !existsSync(modelsJsonPath)) {
      return emptyCustomModelsResult();
    }

    try {
      const content = options.contents ?? readFileSync(modelsJsonPath, "utf-8");
      const parsed = parseModelCatalogJson(content);
      if (options.requireGeneratedCatalog === true && !isGeneratedPluginModelCatalog(parsed)) {
        return emptyCustomModelsResult();
      }

      const valid = validateModelsConfig.Check(parsed);
      const invalidCosts = valid ? undefined : omitInvalidModelCosts(parsed);
      if (!valid && !validateModelsConfig.Check(parsed)) {
        const errors =
          validateModelsConfig
            .Errors(parsed)
            .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
            .join("\n") || "Unknown schema error";
        return emptyCustomModelsResult(
          `Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`,
        );
      }

      const providers =
        options.requireGeneratedCatalog === true
          ? filterGeneratedPluginModelCatalogProviders({
              catalogPluginId: options.catalogPluginId,
              config: this.config,
              isProviderAvailable: (providerId) =>
                this.authStorage.hasAuth(normalizeProviderId(providerId)) ||
                hasUsableCustomProviderApiKey(this.config, providerId) ||
                resolveManagedSecretRefRuntimeProviderAuth({
                  cfg: this.config,
                  provider: providerId,
                }) !== undefined,
              parsedCatalog: parsed,
              pluginMetadataSnapshot: this.pluginMetadataSnapshot,
              providers: parsed.providers,
            })
          : parsed.providers;
      if (options.requireGeneratedCatalog === true && Object.keys(providers).length === 0) {
        return emptyCustomModelsResult();
      }

      const catalogWarnings: string[] = [];
      for (const [providerName, providerConfig] of Object.entries(providers)) {
        this.validateProviderModels(providerName, providerConfig, "catalog");
        if (invalidCosts?.size && providerConfig.models) {
          providerConfig.models = providerConfig.models.filter((model) => {
            if (!invalidCosts.has(model)) {
              return true;
            }
            const source = options.requireGeneratedCatalog
              ? "the provider's catalog source"
              : modelsJsonPath;
            catalogWarnings.push(
              `Skipped model ${providerName}/${model.id}: invalid cost. Fix or remove its cost block in ${source}, then refresh the model catalog.`,
            );
            return false;
          });
        }
      }

      const generated = options.requireGeneratedCatalog === true;
      let sourceProviders: RegistryProviderSources = {};
      for (const [providerName, providerConfig] of Object.entries(providers)) {
        if (!generated && (providerConfig.models ?? []).length > 0) {
          this.storeProviderRequestConfig(providerName, providerConfig);
        }
        // Generated catalogs supply inventory, never request authority. Record the
        // source before merging so their headers cannot replace an authored row's.
        sourceProviders[providerName] = generated
          ? captureProviderSource(providerConfig, "static")
          : captureProviderSource(providerConfig, "authored");
      }

      const pluginCatalogErrors = catalogWarnings.map(
        (warning) => `${warning}\nFile: ${modelsJsonPath}`,
      );
      if (options.includePluginCatalogs !== false) {
        let pluginCatalogs: readonly PersistedPluginModelCatalog[] = [];
        try {
          pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(dirname(modelsJsonPath));
        } catch (error) {
          pluginCatalogErrors.push(
            `Failed to load generated plugin model catalogs: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const pluginResult = this.loadCapturedPluginCatalogs(pluginCatalogs);
        sourceProviders = this.mergeProviderSources(pluginResult.providers, sourceProviders);
        if (pluginResult.error) {
          pluginCatalogErrors.push(
            `${pluginResult.error}\nRun openclaw doctor --fix to repair persisted generated provider catalogs.`,
          );
        }
      }

      return { providers: sourceProviders, error: pluginCatalogErrors.join("\n\n") || undefined };
    } catch (error) {
      if (error instanceof SyntaxError) {
        if (options.requireGeneratedCatalog === true) {
          return emptyCustomModelsResult();
        }
        return emptyCustomModelsResult(
          `Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`,
        );
      }
      return emptyCustomModelsResult(
        `Failed to load models.json: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${modelsJsonPath}`,
      );
    }
  }

  private validateProviderModels(
    providerName: string,
    config: ProviderModelCatalog,
    source: "catalog" | "registration",
  ): void {
    const models = config.models ?? [];
    if (models.length > 0 && !config.baseUrl) {
      const subject = source === "catalog" ? "custom models" : "models";
      throw new Error(`Provider ${providerName}: "baseUrl" is required when defining ${subject}.`);
    }
    for (const model of models) {
      if (!model.api && !config.api) {
        const guidance = source === "catalog" ? " Set at provider or model level." : "";
        throw new Error(
          `Provider ${providerName}, model ${model.id}: no "api" specified.${guidance}`,
        );
      }
      if (source === "catalog") {
        for (const field of ["contextWindow", "maxTokens"] as const) {
          if (model[field] !== undefined && model[field] <= 0) {
            throw new Error(`Provider ${providerName}, model ${model.id}: invalid ${field}`);
          }
        }
      }
    }
  }

  private parseModels(providers: RegistryProviderSources): Model[] {
    const models: Model[] = [];

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      for (const modelDef of providerConfig.models ?? []) {
        const api = modelDef.api ?? providerConfig.api;
        if (!api) {
          continue;
        }

        const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl;
        if (!baseUrl) {
          continue;
        }

        // Project richer persisted metadata to runtime's text/image contract.
        // Unsupported-only rows are not runnable; explicit empty input stays valid.
        const runtimeInput = (modelDef.input ?? ["text"]).filter(
          (input): input is "text" | "image" => input === "text" || input === "image",
        );
        if ((modelDef.input?.length ?? 0) > 0 && runtimeInput.length === 0) {
          continue;
        }

        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
        models.push(
          createRegistryRuntimeModel(providerName, providerConfig, modelDef, api, {
            baseUrl,
            input: runtimeInput,
          }),
        );
      }
    }

    return models;
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
      providerConfig: this.getModelProviderRequestConfig(model),
      authStorage: this.authStorage,
    });
  }

  private getModelProviderRequestConfig(model: Model): ProviderRequestConfig | undefined {
    const config = this.providerRequestConfigs.get(model.provider);
    if (
      config?.baseUrls &&
      !config.baseUrls.some((baseUrl) =>
        modelTransportRoutesMatch({ baseUrl }, { baseUrl: model.baseUrl }),
      )
    ) {
      return undefined;
    }
    return config;
  }

  private storeProviderRequestConfig(
    providerName: string,
    config: {
      baseUrl?: string;
      models?: readonly { baseUrl?: string }[];
      apiKey?: string;
      auth?: ProviderAuthMode;
      headers?: Record<string, string>;
      authHeader?: boolean;
    },
  ): void {
    if (!config.apiKey && !config.auth && !config.headers && !config.authHeader) {
      return;
    }

    this.providerRequestConfigs.set(providerName, {
      // File-authored endpoints authorize these settings; generated destinations do not.
      // Route-less runtime registrations retain their explicit caller-owned scope.
      baseUrls: config.baseUrl
        ? [config.baseUrl, ...(config.models ?? []).flatMap((model) => model.baseUrl ?? [])]
        : undefined,
      apiKey: config.apiKey,
      auth: config.auth,
      headers: config.headers,
      authHeader: config.authHeader,
    });
  }

  private storeModelHeaders(
    providerName: string,
    modelId: string,
    headers?: Record<string, string>,
  ): void {
    const key = JSON.stringify([providerName, modelId]);
    if (!headers || Object.keys(headers).length === 0) {
      this.modelRequestHeaders.delete(key);
      return;
    }
    this.modelRequestHeaders.set(key, headers);
  }

  async getApiKeyAndHeaders(model: Model): Promise<ResolvedRequestAuth> {
    return resolveModelRegistryRequestAuth({
      model,
      providerConfig: this.getModelProviderRequestConfig(model),
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
    this.validateProviderModels(providerName, config, "registration");
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

    this.storeProviderRequestConfig(providerName, config);

    if (config.models && config.models.length > 0) {
      this.models = this.models.filter((m) => m.provider !== providerName);

      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

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

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
