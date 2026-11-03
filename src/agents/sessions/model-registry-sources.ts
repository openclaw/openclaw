import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model, ModelRequestHeaders } from "../../llm/types.js";
import { mergeProviderModels, type ProviderModelCatalog } from "../models-config.merge.js";
import { loadPersistedPluginModelCatalogs } from "../plugin-model-catalog-execution.js";
import type { PersistedPluginModelCatalog } from "../plugin-model-catalog-read.types.js";
import { createRegistryRuntimeModel } from "./model-registry-runtime-model.js";
import type { ModelsConfig, ProviderAuthMode } from "./model-registry-schema.js";

export type RegistryProviderSources = Record<
  string,
  ProviderModelCatalog &
    Pick<ModelsConfig["providers"][string], "apiKey" | "auth" | "authHeader"> & {
      headers?: Record<string, string>;
    }
>;

export function captureProviderSource(
  ...[provider, source]:
    | [provider: RegistryProviderSources[string], source: "authored"]
    | [provider: ProviderModelCatalog, source: "static" | "composed"]
): RegistryProviderSources[string] {
  return {
    ...(source === "authored"
      ? provider
      : { api: provider.api, baseUrl: provider.baseUrl, compat: provider.compat }),
    models: provider.models?.map((model) => {
      const { headers: _headers, ...inventory } = model;
      const maxTokensSource: typeof model.maxTokensSource =
        source === "composed"
          ? model.maxTokensSource
          : source === "static"
            ? "discovered"
            : "configured";
      return Object.assign(source === "authored" ? model : inventory, {
        api: model.api ?? provider.api,
        baseUrl: model.baseUrl ?? provider.baseUrl,
        maxTokensSource,
        compat: source === "composed" ? model.compat : mergeCompat(provider.compat, model.compat),
      });
    }),
  };
}

export function cloneMapValues<T extends object>(source: ReadonlyMap<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function mergeCompat(
  baseCompat: ProviderModelCatalog["compat"],
  overrideCompat: ProviderModelCatalog["compat"],
): ProviderModelCatalog["compat"] {
  if (!overrideCompat) {
    return baseCompat;
  }

  const merged = { ...baseCompat, ...overrideCompat };
  for (const routing of ["openRouterRouting", "vercelGatewayRouting"] as const) {
    if (baseCompat?.[routing] || overrideCompat[routing]) {
      merged[routing] = { ...baseCompat?.[routing], ...overrideCompat[routing] };
    }
  }
  return merged;
}

export async function readModelRegistryPluginCatalogs(
  modelsJsonPath: string,
  options: { config?: OpenClawConfig; modelsJsonContents?: string | null },
): Promise<{ catalogs: readonly PersistedPluginModelCatalog[]; error?: string }> {
  if (
    options.config?.models?.mode === "replace" ||
    options.modelsJsonContents === null ||
    (options.modelsJsonContents === undefined && !existsSync(modelsJsonPath))
  ) {
    return { catalogs: [] };
  }
  try {
    return { catalogs: await loadPersistedPluginModelCatalogs(dirname(modelsJsonPath)) };
  } catch (error) {
    return {
      catalogs: [],
      error: `Failed to load generated plugin model catalogs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface ProviderRequestConfig {
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
      headers?: ModelRequestHeaders;
    }
  | {
      ok: false;
      error: string;
    };

export interface CustomModelsResult {
  providers: RegistryProviderSources;
  error: string | undefined;
}

export function emptyCustomModelsResult(error?: string): CustomModelsResult {
  return { providers: {}, error };
}

export function mergeRegistryProviderSources(
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

export function validateRegistryProviderModels(
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

export function parseRegistryModels(
  providers: RegistryProviderSources,
  storeModelHeaders: (
    providerName: string,
    modelId: string,
    headers?: Record<string, string>,
  ) => void,
): Model[] {
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

      storeModelHeaders(providerName, modelDef.id, modelDef.headers);
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
