import { dirname } from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { canAccess } from "../../infra/path-existence.js";
import type { ModelRequestHeaders } from "../../llm/types.js";
import { planEffectiveModelCatalogRows } from "../../model-catalog/index.js";
import { buildEffectiveManifestProviderConfig } from "../../plugins/provider-catalog.js";
import { mergeProviderModels, type ProviderModelCatalog } from "../models-config.merge.js";
import { loadPersistedPluginModelCatalogs } from "../plugin-model-catalog-execution.js";
import type { PersistedPluginModelCatalog } from "../plugin-model-catalog-read.types.js";
import { filterGeneratedPluginModelCatalogProviders } from "../plugin-model-catalog.js";
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

export function storeModelHeaders(
  target: Map<string, Record<string, string>>,
  providerName: string,
  modelId: string,
  headers?: Record<string, string>,
): void {
  const key = JSON.stringify([providerName, modelId]);
  if (!headers || Object.keys(headers).length === 0) {
    target.delete(key);
    return;
  }
  target.set(key, headers);
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
    (options.modelsJsonContents === undefined && !(await canAccess(modelsJsonPath)))
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

export function mergeProviderSources(
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

export function projectProviderRequestConfig(config: {
  baseUrl?: string;
  models?: readonly { baseUrl?: string }[];
  apiKey?: string;
  auth?: ProviderAuthMode;
  headers?: Record<string, string>;
  authHeader?: boolean;
}): ProviderRequestConfig | undefined {
  if (!config.apiKey && !config.auth && !config.headers && !config.authHeader) {
    return undefined;
  }

  return {
    // File-authored endpoints authorize these settings; generated destinations do not.
    // Route-less runtime registrations retain their explicit caller-owned scope.
    baseUrls: config.baseUrl
      ? [config.baseUrl, ...(config.models ?? []).flatMap((model) => model.baseUrl ?? [])]
      : undefined,
    apiKey: config.apiKey,
    auth: config.auth,
    headers: config.headers,
    authHeader: config.authHeader,
  };
}

/**
 * Admits generated providers the catalog plugin still owns, then describes their listed models
 * with the effective catalog rows (bundled plus hosted). Read-time only: callers that persist
 * generated rows use the plain admission filter so stored rows stay as discovered.
 *
 * The account listing alone decides which models exist: an unlisted catalog row is never added,
 * and a listed ID without a catalog row keeps its discovered values. For a listed ID with a catalog
 * row, the catalog owns the metadata field by field. Generated rows carry no marker separating a
 * provider-reported value from a discovery default (128k context, a $0 cost placeholder), so this
 * applies the rule live discovery already applies to a plugin's own static rows: the catalog value
 * wins and a discovered value fills only what the catalog omits. The row keeps its ID, route and a
 * declared non-chat kind.
 */
export function readGeneratedPluginModelCatalogProviders<
  T extends { models?: readonly { id: string; cost?: unknown; inference?: { chat?: boolean } }[] },
>(params: Parameters<typeof filterGeneratedPluginModelCatalogProviders<T>>[0]): Record<string, T> {
  const providers = filterGeneratedPluginModelCatalogProviders(params);
  const plugin = params.pluginMetadataSnapshot?.manifestRegistry?.plugins.find(
    (candidate) => candidate.id === params.catalogPluginId,
  );
  if (!plugin?.modelCatalog?.providers) {
    return providers;
  }
  return Object.fromEntries(
    Object.entries(providers).map(([providerKey, provider]) => {
      const providerId = normalizeProviderId(providerKey);
      const rows = provider.models?.length
        ? planEffectiveModelCatalogRows({
            registry: { plugins: [plugin] },
            config: params.config ?? {},
            providerFilter: providerId,
          }).rows.filter((row) => row.provider === providerId)
        : [];
      const catalogRows = new Map(rows.map((row) => [row.id, row]));
      const catalogModels = new Map(
        buildEffectiveManifestProviderConfig(rows)?.models.map((model) => [model.id, model]),
      );
      if (catalogModels.size === 0 || !provider.models) {
        return [providerKey, provider];
      }
      const models = provider.models.map((model) => {
        const row = catalogRows.get(model.id);
        const catalogModel = catalogModels.get(model.id);
        if (!row || !catalogModel) {
          return model;
        }
        const { api: _api, baseUrl: _baseUrl, headers: _headers, ...metadata } = catalogModel;
        const { inference: discoveredInference, ...discovered } = model;
        // A declared non-chat kind is listing evidence; weak "unlikely" evidence yields to the row.
        const inference = discoveredInference?.chat === false ? discoveredInference : row.inference;
        return {
          ...discovered,
          ...metadata,
          ...(row.cost ? {} : { cost: model.cost }),
          ...(inference ? { inference } : {}),
        };
      });
      return [providerKey, { ...provider, models }];
    }),
  );
}
