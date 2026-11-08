import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import { sanitizeModelHeaders } from "../embedded-agent-runner/model.inline-provider.js";
import { hasUsableCustomProviderApiKey } from "../model-auth-provider-config.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "../model-auth-runtime-config.js";
import { parseModelCatalogJson } from "../model-catalog-json.js";
import {
  buildSourceModelFields,
  mergeProviderModels,
  normalizeProviderMapKeys,
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
import type { AuthStorage } from "./auth-storage.js";
import { createRegistryRuntimeModel } from "./model-registry-runtime-model.js";
import {
  formatValidationPath,
  omitInvalidModelCosts,
  validateModelsConfig,
  validateModelRegistryProviderModels,
} from "./model-registry-schema.js";
import {
  captureProviderSource,
  emptyCustomModelsResult,
  storeModelRegistryProviderRequestConfig,
  storeModelRegistryHeaders,
  type ProviderRequestConfig,
  type CustomModelsResult,
  type RegistryProviderSources,
} from "./model-registry-sources.js";

const log = createSubsystemLogger("agents/model-registry");

export type ModelRegistryCatalogOptions = {
  config?: OpenClawConfig;
  includePluginCatalogs?: boolean;
  modelsJsonContents?: string | null;
  pluginCatalogs?: readonly PersistedPluginModelCatalog[];
  staticProviderConfigs?: Readonly<Record<string, ModelProviderConfig>>;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
};

/** Compose inventory once; mutable session registries own their own baseline snapshots. */
export function buildModelRegistryCatalog(
  authStorage: AuthStorage,
  modelsJsonPath: string | undefined,
  options: ModelRegistryCatalogOptions & {
    pluginCatalogReadError?: string;
    inspectLegacyCatalogs?: boolean;
  },
) {
  const providerRequestConfigs = new Map<string, ProviderRequestConfig>();
  const modelRequestHeaders = new Map<string, Record<string, string>>();
  const includePluginCatalogs = options.includePluginCatalogs !== false;
  let loadError: string | undefined;
  function mergeProviderSources(
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

  function loadCapturedPluginCatalogs(
    pluginCatalogs: readonly PersistedPluginModelCatalog[],
  ): CustomModelsResult {
    let providers: RegistryProviderSources = {};
    const errors: string[] = [];
    for (const pluginCatalog of pluginCatalogs) {
      const result = loadCustomModels(`sqlite:plugin-model-catalog/${pluginCatalog.pluginId}`, {
        catalogPluginId: pluginCatalog.pluginId,
        contents: pluginCatalog.contents,
        includePluginCatalogs: false,
        requireGeneratedCatalog: true,
      });
      providers = mergeProviderSources(providers, result.providers);
      if (result.error) {
        errors.push(result.error);
      }
    }
    return { providers, error: errors.join("\n\n") || undefined };
  }

  function loadCustomModels(
    modelsJsonPath: string,
    sourceOptions: {
      catalogPluginId?: string;
      contents?: string;
      includePluginCatalogs?: boolean;
      requireGeneratedCatalog?: boolean;
    } = {
      includePluginCatalogs: true,
    },
  ): CustomModelsResult {
    if (sourceOptions.contents === undefined && !existsSync(modelsJsonPath)) {
      return emptyCustomModelsResult();
    }

    try {
      const content = sourceOptions.contents ?? readFileSync(modelsJsonPath, "utf-8");
      const parsed = parseModelCatalogJson(content);
      if (
        sourceOptions.requireGeneratedCatalog === true &&
        !isGeneratedPluginModelCatalog(parsed)
      ) {
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
        sourceOptions.requireGeneratedCatalog === true
          ? filterGeneratedPluginModelCatalogProviders({
              catalogPluginId: sourceOptions.catalogPluginId,
              config: options.config,
              isProviderAvailable: (providerId) =>
                authStorage.hasAuth(normalizeProviderId(providerId)) ||
                hasUsableCustomProviderApiKey(options.config, providerId) ||
                resolveManagedSecretRefRuntimeProviderAuth({
                  cfg: options.config,
                  provider: providerId,
                }) !== undefined,
              parsedCatalog: parsed,
              pluginMetadataSnapshot: options.pluginMetadataSnapshot,
              providers: parsed.providers,
            })
          : parsed.providers;
      if (sourceOptions.requireGeneratedCatalog === true && Object.keys(providers).length === 0) {
        return emptyCustomModelsResult();
      }

      const catalogWarnings: string[] = [];
      for (const [providerName, providerConfig] of Object.entries(providers)) {
        validateModelRegistryProviderModels(providerName, providerConfig, "catalog");
        if (invalidCosts?.size && providerConfig.models) {
          providerConfig.models = providerConfig.models.filter((model) => {
            if (!invalidCosts.has(model)) {
              return true;
            }
            const source = sourceOptions.requireGeneratedCatalog
              ? "the provider's catalog source"
              : modelsJsonPath;
            catalogWarnings.push(
              `Skipped model ${providerName}/${model.id}: invalid cost. Fix or remove its cost block in ${source}, then refresh the model catalog.`,
            );
            return false;
          });
        }
      }

      const generated = sourceOptions.requireGeneratedCatalog === true;
      let sourceProviders: RegistryProviderSources = {};
      for (const [providerName, providerConfig] of Object.entries(providers)) {
        if (!generated && (providerConfig.models ?? []).length > 0) {
          storeModelRegistryProviderRequestConfig(
            providerRequestConfigs,
            providerName,
            providerConfig,
          );
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
      if (sourceOptions.includePluginCatalogs !== false) {
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
        const pluginResult = loadCapturedPluginCatalogs(pluginCatalogs);
        sourceProviders = mergeProviderSources(pluginResult.providers, sourceProviders);
        if (pluginResult.error) {
          pluginCatalogErrors.push(
            `${pluginResult.error}\nRun openclaw doctor --fix to repair persisted generated provider catalogs.`,
          );
        }
      }

      return { providers: sourceProviders, error: pluginCatalogErrors.join("\n\n") || undefined };
    } catch (error) {
      if (error instanceof SyntaxError) {
        if (sourceOptions.requireGeneratedCatalog === true) {
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

  function parseModels(providers: RegistryProviderSources): Model[] {
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

        storeModelRegistryHeaders(modelRequestHeaders, providerName, modelDef.id, modelDef.headers);
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

  // Keep authored models.json separate from rebuildable provider catalogs
  // owned by the agent SQLite cache.
  const replace = options.config?.models?.mode === "replace";
  const customResult =
    !replace && modelsJsonPath && options.modelsJsonContents !== null
      ? loadCustomModels(modelsJsonPath, {
          ...(options.modelsJsonContents !== undefined
            ? { contents: options.modelsJsonContents }
            : {}),
          includePluginCatalogs: includePluginCatalogs && options.pluginCatalogs === undefined,
        })
      : emptyCustomModelsResult();
  const capturedPluginResult =
    !replace && includePluginCatalogs && options.pluginCatalogs !== undefined
      ? loadCapturedPluginCatalogs(options.pluginCatalogs)
      : emptyCustomModelsResult();
  const errors = [
    customResult.error,
    capturedPluginResult.error,
    options.pluginCatalogReadError,
  ].filter((error): error is string => Boolean(error));

  if (
    !replace &&
    modelsJsonPath &&
    options.modelsJsonContents === undefined &&
    options.inspectLegacyCatalogs &&
    options.staticProviderConfigs === undefined &&
    includePluginCatalogs
  ) {
    // Only explicit disk discovery/refresh inspects legacy sources; hot lookups
    // and lifecycle-captured registries consume their existing catalog snapshot.
    const inspected = inspectLegacyPluginModelCatalogs(dirname(modelsJsonPath));
    const diagnostics = [
      ...inspected.warnings,
      ...inspected.catalogs.map(({ pathname }) => `Legacy generated provider catalog: ${pathname}`),
    ];
    if (diagnostics.length > 0) {
      errors.push(
        `${diagnostics.join("\n")}\nRun openclaw doctor --fix to verify and import legacy provider catalogs.`,
      );
    }
  }

  if (errors.length > 0) {
    loadError = errors.join("\n\n");
    log.warn(`model catalog load issue: ${loadError}`);
    // Plugin catalog failures can return salvaged models; root failures return empty.
  }

  const providers = mergeProviderSources(
    replace
      ? {}
      : Object.fromEntries(
          Object.entries(options.staticProviderConfigs ?? {}).map(([provider, config]) => [
            provider,
            captureProviderSource(config, "static"),
          ]),
        ),
    capturedPluginResult.providers,
    customResult.providers,
  );
  const sourceFields = buildSourceModelFields(
    materializeConfiguredProviderCatalogModels(
      options.config && projectConfigOntoRuntimeSourceSnapshot(options.config).models?.providers,
      { manifestPlugins: options.pluginMetadataSnapshot },
    ),
  );
  for (const [providerId, configured] of Object.entries(
    normalizeProviderMapKeys(
      materializeConfiguredProviderCatalogModels(options.config?.models?.providers, {
        manifestPlugins: options.pluginMetadataSnapshot,
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
    providerRequestConfigs.delete(providerId);
    // Current config owns provider request settings, including accepted catalog routes.
    // File-only callers retain the authored-endpoint scope captured by loadCustomModels.
    storeModelRegistryProviderRequestConfig(providerRequestConfigs, providerId, {
      apiKey: normalizeOptionalSecretInput(configured.apiKey),
      auth: configured.auth,
      authHeader: configured.authHeader,
      headers: sanitizeModelHeaders(configured.headers),
    });
  }
  let combined = parseModels(providers);

  for (const oauthProvider of authStorage.getOAuthProviders()) {
    const cred = authStorage.get(oauthProvider.id);
    if (cred?.type === "oauth" && oauthProvider.modifyModels) {
      combined = oauthProvider.modifyModels(combined, cred);
    }
  }

  const models = combined;
  return { models, providerRequestConfigs, modelRequestHeaders, loadError };
}
