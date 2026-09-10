/**
 * Model registry - manages configured/provider-owned models and API key resolution.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeResolvedPricing } from "@openclaw/llm-core";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  SimpleStreamOptions,
} from "../../llm/types.js";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import { getAgentDir } from "../config.js";
import { sanitizeModelHeaders } from "../embedded-agent-runner/model.inline-provider.js";
import { hasUsableCustomProviderApiKey } from "../model-auth-provider-config.js";
import { parseModelCatalogJson } from "../model-catalog-json.js";
import { modelTransportRoutesMatch } from "../model-compat-catalog.js";
import { resolveModelPluginMetadataSnapshot } from "../model-discovery-context.js";
import {
  buildSourceModelFields,
  mergeProviderModels,
  normalizeProviderMapKeys,
  type ProviderModelCatalog,
} from "../models-config.merge.js";
import { materializeConfiguredProviderCatalogModels } from "../models-config.providers.normalize.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogs,
  type PersistedPluginModelCatalog,
  type PluginModelCatalogMetadataSnapshot,
} from "../plugin-model-catalog.js";
import { getAuthStorageOAuthProviderRegistry } from "./auth-storage-oauth-registry.js";
import type { AuthStatus, AuthStorage } from "./auth-storage.js";
import {
  getModelRegistryRuntime,
  initializeModelRegistryRuntime,
  resetModelRegistryRuntime,
} from "./model-registry-runtime.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.js";
import {
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";

const log = createSubsystemLogger("agents/model-registry");

// Schema for OpenRouter routing preferences
const PercentileCutoffsSchema = Type.Object({
  p50: Type.Optional(Type.Number()),
  p75: Type.Optional(Type.Number()),
  p90: Type.Optional(Type.Number()),
  p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
  allow_fallbacks: Type.Optional(Type.Boolean()),
  require_parameters: Type.Optional(Type.Boolean()),
  data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
  zdr: Type.Optional(Type.Boolean()),
  enforce_distillable_text: Type.Optional(Type.Boolean()),
  order: Type.Optional(Type.Array(Type.String())),
  only: Type.Optional(Type.Array(Type.String())),
  ignore: Type.Optional(Type.Array(Type.String())),
  quantizations: Type.Optional(Type.Array(Type.String())),
  sort: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Object({
        by: Type.Optional(Type.String()),
        partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    ]),
  ),
  max_price: Type.Optional(
    Type.Object({
      prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    }),
  ),
  preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
  preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String())),
});

// Schema for thinking level support and provider-specific values
const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
  off: Type.Optional(ThinkingLevelMapValueSchema),
  minimal: Type.Optional(ThinkingLevelMapValueSchema),
  low: Type.Optional(ThinkingLevelMapValueSchema),
  medium: Type.Optional(ThinkingLevelMapValueSchema),
  high: Type.Optional(ThinkingLevelMapValueSchema),
  xhigh: Type.Optional(ThinkingLevelMapValueSchema),
  max: Type.Optional(ThinkingLevelMapValueSchema),
});

const OpenAICompletionsCompatSchema = Type.Object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(
    Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")]),
  ),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("openrouter"),
      Type.Literal("together"),
      Type.Literal("deepseek"),
      Type.Literal("zai"),
      Type.Literal("qwen"),
      Type.Literal("qwen-chat-template"),
    ]),
  ),
  cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
  openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
  vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  supportsJsonSchemaResponseFormat: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
  supportsTemperature: Type.Optional(Type.Boolean()),
  supportsInstructions: Type.Optional(Type.Boolean()),
  sendSessionIdHeader: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
  supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Union([
  OpenAICompletionsCompatSchema,
  OpenAIResponsesCompatSchema,
  AnthropicMessagesCompatSchema,
]);

const ProviderAuthModeSchema = Type.Union([
  Type.Literal("api-key"),
  Type.Literal("aws-sdk"),
  Type.Literal("oauth"),
  Type.Literal("token"),
]);
type ProviderAuthMode = Static<typeof ProviderAuthModeSchema>;

// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
  input: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("text"),
        Type.Literal("image"),
        Type.Literal("audio"),
        Type.Literal("video"),
      ]),
    ),
  ),
  cost: Type.Optional(
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
    }),
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  auth: Type.Optional(ProviderAuthModeSchema),
  api: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(ProviderCompatSchema),
  authHeader: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Array(ModelDefinitionSchema)),
});

const ModelsConfigSchema = Type.Object({
  generatedBy: Type.Optional(Type.String()),
  providers: Type.Record(Type.String(), ProviderConfigSchema),
});

const validateModelsConfig = Compile(ModelsConfigSchema);

type ModelsConfig = Static<typeof ModelsConfigSchema>;
type MaxTokensSource = "configured" | "discovered";
type RegistryProviderSources = Record<
  string,
  ProviderModelCatalog &
    Pick<ModelsConfig["providers"][string], "apiKey" | "auth" | "authHeader"> & {
      headers?: Record<string, string>;
    }
>;

function captureInventoryProvider(
  provider: ProviderModelCatalog,
  source: "static" | "composed",
): RegistryProviderSources[string] {
  return {
    api: provider.api,
    baseUrl: provider.baseUrl,
    compat: provider.compat,
    models: provider.models?.map(({ headers: _headers, ...model }) => ({
      ...model,
      api: model.api ?? provider.api,
      baseUrl: model.baseUrl ?? provider.baseUrl,
      maxTokensSource: source === "static" ? "discovered" : model.maxTokensSource,
      compat: source === "static" ? mergeCompat(provider.compat, model.compat) : model.compat,
    })),
  };
}

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (error.params as { requiredProperties?: string[] })
      .requiredProperties;
    const requiredProperty = requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

interface ProviderRequestConfig {
  baseUrls?: readonly string[];
  apiKey?: string;
  auth?: ProviderAuthMode;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

/** Result of loading custom models from models.json */
interface CustomModelsResult {
  providers: RegistryProviderSources;
  error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
  return { providers: {}, error };
}

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

function mergeCompat(
  baseCompat: Model["compat"],
  overrideCompat: Model["compat"],
): Model["compat"] | undefined {
  if (!overrideCompat) {
    return baseCompat;
  }

  const base = baseCompat;
  const override = overrideCompat;
  const merged = { ...base, ...override } as
    | OpenAICompletionsCompat
    | OpenAIResponsesCompat
    | AnthropicMessagesCompat;

  const baseCompletions = base as OpenAICompletionsCompat | undefined;
  const overrideCompletions = override as OpenAICompletionsCompat;
  const mergedCompletions = merged as OpenAICompletionsCompat;

  if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
    mergedCompletions.openRouterRouting = {
      ...baseCompletions?.openRouterRouting,
      ...overrideCompletions.openRouterRouting,
    };
  }

  if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
    mergedCompletions.vercelGatewayRouting = {
      ...baseCompletions?.vercelGatewayRouting,
      ...overrideCompletions.vercelGatewayRouting,
    };
  }

  return merged as Model["compat"];
}

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
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
  private staticProviderConfigs: Readonly<Record<string, ModelProviderConfig>> | undefined;
  private pluginMetadataSnapshot: PluginModelCatalogMetadataSnapshot | undefined;
  private includePluginCatalogs = true;
  private baseCatalogSnapshot: ModelRegistryCatalogSnapshot | undefined;
  private sourceSnapshot: ModelRegistryCatalogSnapshot | undefined;

  private constructor(
    authStorage: AuthStorage,
    modelsJsonPath: string | undefined,
    options: ModelRegistryOptions = {},
  ) {
    this.authStorage = authStorage;
    this.config = options.config ?? options.sourceSnapshot?.config;
    this.includePluginCatalogs = options.includePluginCatalogs !== false;
    initializeModelRegistryRuntime(this);
    if (options.sourceSnapshot) {
      const source = options.sourceSnapshot;
      const sourceSnapshot = source.baseCatalogSnapshot ?? source.captureCatalogSnapshot();
      this.sourceSnapshot = sourceSnapshot;
      this.baseCatalogSnapshot = sourceSnapshot;
      this.restoreSourceCatalog(sourceSnapshot);
      this.registeredProviders = new Map(
        [...source.registeredProviders].map(([provider, config]) => [provider, { ...config }]),
      );
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
    this.pluginCatalogs = options.pluginCatalogs;
    this.staticProviderConfigs = options.staticProviderConfigs;
    this.pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
      ...(options.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: options.pluginMetadataSnapshot }
        : {}),
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      allowWorkspaceScopedCurrent: true,
      useRuntimeConfig: true,
    });
    this.loadModels();
    this.baseCatalogSnapshot = this.captureCatalogSnapshot();
  }

  private captureCatalogSnapshot(): ModelRegistryCatalogSnapshot {
    return {
      models: structuredClone(this.models),
      providerRequestConfigs: new Map(
        [...this.providerRequestConfigs].map(([provider, config]) => [provider, { ...config }]),
      ),
      modelRequestHeaders: new Map(
        [...this.modelRequestHeaders].map(([key, headers]) => [key, { ...headers }]),
      ),
      loadError: this.loadError,
      pluginMetadataSnapshot: this.pluginMetadataSnapshot,
      oauthProviders: [...this.authStorage.getOAuthProviders()],
    };
  }

  private restoreSourceCatalog(source: ModelRegistryCatalogSnapshot): void {
    this.models = structuredClone(source.models);
    this.providerRequestConfigs = new Map(
      [...source.providerRequestConfigs].map(([provider, config]) => [provider, { ...config }]),
    );
    this.modelRequestHeaders = new Map(
      [...source.modelRequestHeaders].map(([key, headers]) => [key, { ...headers }]),
    );
    this.loadError = source.loadError;
    this.pluginMetadataSnapshot = source.pluginMetadataSnapshot;
  }

  static create(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): ModelRegistry {
    return new ModelRegistry(authStorage, modelsJsonPath, options);
  }

  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  /** Creates a request-isolated registry from this lifecycle-owned catalog snapshot. */
  fork(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined, { sourceSnapshot: this });
  }

  /**
   * Reload models from disk (models.json).
   */
  refresh(): void {
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
    const errors = [customResult.error, capturedPluginResult.error].filter(
      (error): error is string => Boolean(error),
    );

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
              captureInventoryProvider(config, "static"),
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
        models: configured.models.map((model) => ({
          ...model,
          api: model.api ?? accepted.get(model.id)?.api ?? configured.api,
          baseUrl: model.baseUrl ?? accepted.get(model.id)?.baseUrl ?? configured.baseUrl,
          maxTokensSource: "configured",
          headers: sanitizeModelHeaders(model.headers, { stripSecretRefMarkers: true }),
        })),
      };
      providers[providerId] = inherited
        ? mergeProviderModels(captureInventoryProvider(inherited, "composed"), current, {
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
        headers: sanitizeModelHeaders(configured.headers, { stripSecretRefMarkers: true }),
      });
    }
    let combined = this.parseModels(providers);

    // Let OAuth providers modify their models (e.g., update baseUrl)
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

      if (!validateModelsConfig.Check(parsed)) {
        const errors =
          validateModelsConfig
            .Errors(parsed)
            .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
            .join("\n") || "Unknown schema error";
        return emptyCustomModelsResult(
          `Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`,
        );
      }

      const config = parsed;
      const providers =
        options.requireGeneratedCatalog === true
          ? filterGeneratedPluginModelCatalogProviders({
              catalogPluginId: options.catalogPluginId,
              config: this.config,
              isProviderAvailable: (providerId) =>
                this.authStorage.hasAuth(normalizeProviderId(providerId)) ||
                hasUsableCustomProviderApiKey(this.config, providerId),
              parsedCatalog: parsed,
              pluginMetadataSnapshot: this.pluginMetadataSnapshot,
              providers: config.providers,
            })
          : config.providers;
      const configForUse = { ...config, providers };
      if (options.requireGeneratedCatalog === true && Object.keys(providers).length === 0) {
        return emptyCustomModelsResult();
      }

      // Additional validation
      this.validateConfig(configForUse);

      const generated = options.requireGeneratedCatalog === true;
      const maxTokensSource: MaxTokensSource = generated ? "discovered" : "configured";
      let sourceProviders: RegistryProviderSources = {};
      for (const [providerName, providerConfig] of Object.entries(configForUse.providers)) {
        if (!generated && (providerConfig.models ?? []).length > 0) {
          this.storeProviderRequestConfig(providerName, providerConfig);
        }
        // Generated catalogs supply inventory, never request authority. Record the
        // source before merging so their headers cannot replace an authored row's.
        sourceProviders[providerName] = {
          ...(generated
            ? {
                api: providerConfig.api,
                baseUrl: providerConfig.baseUrl,
                compat: providerConfig.compat,
              }
            : providerConfig),
          models: providerConfig.models?.map((model) => {
            const { headers: _headers, ...inventory } = model;
            // Capture route and effective compatibility before provider defaults merge.
            return Object.assign(generated ? inventory : model, {
              maxTokensSource,
              api: model.api ?? providerConfig.api,
              baseUrl: model.baseUrl ?? providerConfig.baseUrl,
              compat: mergeCompat(providerConfig.compat, model.compat),
            });
          }),
        };
      }

      const pluginCatalogErrors: string[] = [];
      if (options.includePluginCatalogs !== false) {
        let pluginCatalogs: readonly PersistedPluginModelCatalog[] = [];
        try {
          const loaded = loadPersistedPluginModelCatalogs(dirname(modelsJsonPath));
          pluginCatalogs = loaded.catalogs;
          pluginCatalogErrors.push(...loaded.warnings);
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
          pluginCatalogErrors.push(pluginResult.error);
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

  private validateConfig(config: ModelsConfig): void {
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const hasProviderApi = Boolean(providerConfig.api);
      const models = providerConfig.models ?? [];

      if (models.length === 0) {
        continue;
      }

      // Provider-owned/custom catalogs must be self-contained.
      if (!providerConfig.baseUrl) {
        throw new Error(
          `Provider ${providerName}: "baseUrl" is required when defining custom models.`,
        );
      }
      for (const modelDef of models) {
        const hasModelApi = Boolean(modelDef.api);

        if (!hasProviderApi && !hasModelApi) {
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
          );
        }

        if (!modelDef.id) {
          throw new Error(`Provider ${providerName}: model missing "id"`);
        }
        // Validate contextWindow/maxTokens only if provided (they have defaults)
        if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
        }
        if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
        }
      }
    }
  }

  private parseModels(providers: RegistryProviderSources): Model[] {
    const models: Model[] = [];

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      const modelDefs = providerConfig.models ?? [];
      if (modelDefs.length === 0) {
        continue;
      }

      for (const modelDef of modelDefs) {
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
        models.push({
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider: providerName,
          baseUrl,
          reasoning: modelDef.reasoning ?? false,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: runtimeInput,
          cost: normalizeResolvedPricing(modelDef.cost ?? {}),
          contextWindow: modelDef.contextWindow ?? 128000,
          maxTokens: modelDef.maxTokens ?? 16384,
          ...(modelDef.maxTokens !== undefined
            ? { maxTokensSource: modelDef.maxTokensSource }
            : {}),
          params: modelDef.params,
          headers: undefined,
          compat: modelDef.compat,
        } as Model);
      }
    }

    return models;
  }

  /**
   * Get all configured models.
   */
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

  /**
   * Find a model by provider and ID.
   */
  find(provider: string, modelId: string): Model | undefined {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  /**
   * Get API key for a model.
   */
  hasConfiguredAuth(model: Model): boolean {
    const providerConfig = this.getModelProviderRequestConfig(model);
    return (
      this.authStorage.hasAuth(model.provider) ||
      providerConfig?.auth === "aws-sdk" ||
      providerConfig?.apiKey !== undefined
    );
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

  private getModelRequestKey(provider: string, modelId: string): string {
    return JSON.stringify([provider, modelId]);
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
    const key = this.getModelRequestKey(providerName, modelId);
    if (!headers || Object.keys(headers).length === 0) {
      this.modelRequestHeaders.delete(key);
      return;
    }
    this.modelRequestHeaders.set(key, headers);
  }

  /**
   * Get API key and request headers for a model.
   */
  async getApiKeyAndHeaders(model: Model): Promise<ResolvedRequestAuth> {
    try {
      const providerConfig = this.getModelProviderRequestConfig(model);
      const usesAwsSdkAuth = providerConfig?.auth === "aws-sdk";
      const apiKeyFromAuthStorage = usesAwsSdkAuth
        ? undefined
        : await this.authStorage.getApiKey(model.provider, {
            includeFallback: false,
            baseUrl: model.baseUrl,
          });
      const apiKey =
        apiKeyFromAuthStorage ??
        (!usesAwsSdkAuth && providerConfig?.apiKey
          ? resolveConfigValueOrThrow(
              providerConfig.apiKey,
              `API key for provider "${model.provider}"`,
            )
          : undefined);

      const providerHeaders = resolveHeadersOrThrow(
        providerConfig?.headers,
        `provider "${model.provider}"`,
      );
      const modelHeaders = resolveHeadersOrThrow(
        this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
        `model "${model.provider}/${model.id}"`,
      );

      let headers =
        model.headers || providerHeaders || modelHeaders
          ? { ...model.headers, ...providerHeaders, ...modelHeaders }
          : undefined;

      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }

      return {
        ok: true,
        apiKey,
        headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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

  /**
   * Get display name for a provider.
   */
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

  /**
   * Get API key for a provider.
   */
  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
    if (apiKey !== undefined) {
      return apiKey;
    }

    const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
    return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
  }

  /**
   * Check if a model is using OAuth credentials (subscription).
   */
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
    this.validateProviderConfig(providerName, config);
    this.applyProviderConfig(providerName, config);
    this.upsertRegisteredProvider(providerName, config);
  }

  /**
   * Unregister a previously registered provider.
   *
   * Removes the provider from the registry and reloads models from disk.
   * Also resets dynamic OAuth and API stream registrations before reapplying
   * remaining dynamic providers.
   * Has no effect if the provider was never registered.
   */
  unregisterProvider(providerName: string): void {
    if (!this.registeredProviders.has(providerName)) {
      return;
    }
    this.registeredProviders.delete(providerName);
    this.refresh();
  }

  /**
   * Upsert a provider config into registeredProviders.
   * If the provider is already registered, defined values in the incoming config
   * override existing ones; undefined values are preserved from the stored config.
   * If the provider is not registered, the incoming config is stored as-is.
   */
  private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
    const existing = this.registeredProviders.get(providerName);
    if (!existing) {
      this.registeredProviders.set(providerName, config);
      return;
    }
    for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
      if (config[k] !== undefined) {
        (existing as Record<string, unknown>)[k] = config[k];
      }
    }
  }

  private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.streamSimple && !config.api) {
      throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
    }

    if (!config.models || config.models.length === 0) {
      return;
    }

    if (!config.baseUrl) {
      throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
    }
    for (const modelDef of config.models) {
      const api = modelDef.api || config.api;
      if (!api) {
        throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
      }
    }
  }

  private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
    // Register OAuth provider if provided
    if (config.oauth) {
      // Ensure the OAuth provider ID matches the provider name
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
      // Full replacement: remove existing models for this provider
      this.models = this.models.filter((m) => m.provider !== providerName);

      // Parse and add new models
      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

        this.models.push({
          id: modelDef.id,
          name: modelDef.name,
          api: api as Api,
          provider: providerName,
          baseUrl: modelDef.baseUrl ?? config.baseUrl!,
          reasoning: modelDef.reasoning,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: modelDef.input,
          cost: modelDef.cost,
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
          params: modelDef.params,
          headers: undefined,
          compat: modelDef.compat,
        } as Model);
      }

      // Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
      if (config.oauth?.modifyModels) {
        const cred = this.authStorage.get(providerName);
        if (cred?.type === "oauth") {
          this.models = config.oauth.modifyModels(this.models, cred);
        }
      }
    }
  }
}

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  auth?: ProviderAuthMode;
  api?: Api;
  streamSimple?: (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStreamContract;
  headers?: Record<string, string>;
  authHeader?: boolean;
  /** OAuth provider for /login support */
  oauth?: Omit<OAuthProviderInterface, "id">;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    thinkingLevelMap?: Model["thinkingLevelMap"];
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
    compat?: Model["compat"];
  }>;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
