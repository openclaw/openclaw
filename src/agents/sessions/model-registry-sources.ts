import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRequestHeaders } from "../../llm/types.js";
import type { ProviderModelCatalog } from "../models-config.merge.js";
import { loadPersistedPluginModelCatalogs } from "../plugin-model-catalog-execution.js";
import type { PersistedPluginModelCatalog } from "../plugin-model-catalog-read.types.js";
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
