/**
 * Resolves bundled static catalog rows for embedded-agent model selection.
 */
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planManifestModelCatalogRows } from "../../model-catalog/manifest-planner.js";
import { listOpenClawPluginManifestMetadata } from "../../plugins/manifest-metadata-scan.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import {
  normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders,
  runProviderStaticCatalog,
} from "../../plugins/provider-discovery.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProviderRef,
} from "../../plugins/providers.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";

/**
 * Resolves bundled plugin static model-catalog rows into runtime model records.
 */
function rowMatchesModel(params: {
  row: NormalizedModelCatalogRow;
  provider: string;
  modelId: string;
}): boolean {
  return staticModelIdMatches({
    candidateId: params.row.id,
    provider: params.provider,
    modelId: params.modelId,
    rowProvider: params.row.provider,
  });
}

function staticModelIdMatches(params: {
  candidateId: string;
  provider: string;
  modelId: string;
  rowProvider?: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (params.rowProvider && normalizeProviderId(params.rowProvider) !== normalizedProvider) {
    return false;
  }
  return (
    normalizeStaticProviderModelId(normalizedProvider, params.candidateId).trim().toLowerCase() ===
    normalizeStaticProviderModelId(normalizedProvider, params.modelId).trim().toLowerCase()
  );
}

function normalizeStaticCatalogInput(
  input: readonly unknown[] | undefined,
): ProviderRuntimeModel["input"] {
  const normalizedInput = (input ?? []).filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  return normalizedInput.length > 0 ? normalizedInput : ["text"];
}

function normalizeStaticCatalogCost(
  cost: NormalizedModelCatalogRow["cost"],
): ProviderRuntimeModel["cost"] {
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cacheRead ?? 0,
    cacheWrite: cost?.cacheWrite ?? 0,
  };
}

/** Converts a normalized catalog row into the provider runtime model shape. */
function modelFromStaticCatalogRow(row: NormalizedModelCatalogRow): ProviderRuntimeModel {
  return {
    id: row.id,
    name: row.name || row.id,
    provider: row.provider,
    api: row.api ?? "openai-responses",
    baseUrl: row.baseUrl ?? "",
    reasoning: row.reasoning,
    input: normalizeStaticCatalogInput(row.input),
    cost: normalizeStaticCatalogCost(row.cost),
    contextWindow: row.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
    contextTokens: row.contextTokens,
    maxTokens: row.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
    headers: row.headers,
    compat: row.compat,
    mediaInput: row.mediaInput,
  };
}

function modelFromProviderStaticCatalog(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelProviderConfig["models"][number];
}): ProviderRuntimeModel {
  const [model] = buildInlineProviderModels({
    [params.provider]: { ...params.providerConfig, models: [params.model] },
  });
  return {
    ...model,
    id: model?.id ?? params.model.id,
    name: model?.name || params.model.name || params.model.id,
    provider: params.provider,
    api: model?.api ?? params.model.api ?? params.providerConfig.api ?? "openai-responses",
    baseUrl: model?.baseUrl ?? params.model.baseUrl ?? params.providerConfig.baseUrl ?? "",
    reasoning: model?.reasoning ?? params.model.reasoning ?? false,
    input: normalizeStaticCatalogInput(model?.input ?? params.model.input),
    cost: model?.cost ?? normalizeStaticCatalogCost(params.model.cost),
    contextWindow:
      model?.contextWindow ??
      params.model.contextWindow ??
      params.providerConfig.contextWindow ??
      DEFAULT_CONTEXT_TOKENS,
    contextTokens:
      model?.contextTokens ?? params.model.contextTokens ?? params.providerConfig.contextTokens,
    maxTokens:
      model?.maxTokens ??
      params.model.maxTokens ??
      params.providerConfig.maxTokens ??
      DEFAULT_CONTEXT_TOKENS,
    ...(params.providerConfig.authHeader !== undefined
      ? { authHeader: params.providerConfig.authHeader }
      : {}),
  };
}

type StaticCatalogPlugin = Parameters<
  typeof planManifestModelCatalogRows
>[0]["registry"]["plugins"][number];

function listBundledStaticCatalogPlugins(env: NodeJS.ProcessEnv): StaticCatalogPlugin[] {
  return listOpenClawPluginManifestMetadata(env).flatMap((record): StaticCatalogPlugin[] => {
    if (record.origin !== "bundled") {
      return [];
    }
    const loaded = loadPluginManifest(record.pluginDir);
    if (!loaded.ok || !loaded.manifest.modelCatalog) {
      return [];
    }
    return [
      {
        id: loaded.manifest.id,
        providers: loaded.manifest.providers,
        modelCatalog: loaded.manifest.modelCatalog,
      },
    ];
  });
}

function resolveManifestModelCatalogProviderAlias(params: {
  provider: string;
  plugins: readonly Pick<PluginManifestRecord, "providers" | "modelCatalog">[];
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return undefined;
  }
  const targets = new Set<string>();
  for (const plugin of params.plugins) {
    for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      const normalizedAlias = normalizeProviderId(rawAlias);
      const normalizedTarget = normalizeProviderId(alias.provider);
      if (
        normalizedAlias === provider &&
        normalizedTarget &&
        plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedTarget)
      ) {
        targets.add(normalizedTarget);
      }
    }
  }
  return targets.size === 1 ? [...targets][0] : undefined;
}

/** Resolves a provider alias from plugin model-catalog metadata when the alias is unambiguous. */
export function canonicalizeManifestModelCatalogProviderAlias(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return params.provider;
  }
  return (
    resolveManifestModelCatalogProviderAlias({
      provider,
      plugins: loadPluginManifestRegistry({
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        env: params.env ?? process.env,
      }).plugins,
    }) ?? params.provider
  );
}

/** Returns whether a bundled static catalog asks runtime discovery to augment its rows. */
export function bundledStaticCatalogProviderUsesRuntimeAugment(params: {
  provider: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return false;
  }
  return listBundledStaticCatalogPlugins(params.env ?? process.env).some((plugin) => {
    const catalog = plugin.modelCatalog;
    if (catalog?.runtimeAugment !== true) {
      return false;
    }
    return (
      Object.keys(catalog.providers ?? {}).some(
        (candidate) => normalizeProviderId(candidate) === provider,
      ) ||
      Object.keys(catalog.aliases ?? {}).some(
        (candidate) => normalizeProviderId(candidate) === provider,
      )
    );
  });
}

/** Resolves one bundled static-catalog model row for provider/model lookup. */
export function resolveBundledStaticCatalogModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeRuntimeDiscovery?: boolean;
}): ProviderRuntimeModel | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider || !params.modelId.trim()) {
    return undefined;
  }
  const bundledStaticPlugins = listBundledStaticCatalogPlugins(params.env ?? process.env);
  if (bundledStaticPlugins.length === 0) {
    return undefined;
  }
  const plan = planManifestModelCatalogRows({
    registry: { plugins: bundledStaticPlugins },
    providerFilter: provider,
  });
  for (const entry of plan.entries) {
    if (
      entry.discovery !== "static" &&
      !(params.includeRuntimeDiscovery && entry.discovery === "runtime")
    ) {
      // Static lookups normally ignore runtime-discovery rows. Callers opt in only when they are
      // merging static catalog facts with already-discovered provider runtime state.
      continue;
    }
    const row = entry.rows.find((candidate) =>
      rowMatchesModel({
        row: candidate,
        provider,
        modelId: params.modelId,
      }),
    );
    if (row) {
      return modelFromStaticCatalogRow(row);
    }
  }
  return undefined;
}

/**
 * Resolves one bundled provider static-catalog model row for provider/model lookup.
 *
 * Some bundled providers expose their canonical offline rows through
 * `providerCatalogEntry` instead of manifest `modelCatalog`. This keeps the
 * skip-discovery fallback aligned with model list/inspect without running live
 * discovery or untrusted workspace plugins.
 */
export async function resolveBundledProviderStaticCatalogModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderRuntimeModel | undefined> {
  const env = params.env ?? process.env;
  const provider = normalizeProviderId(params.provider);
  if (!provider || !params.modelId.trim()) {
    return undefined;
  }
  const pluginIds = resolveOwningPluginIdsForProviderRef({
    provider,
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env,
  });
  if (!pluginIds || pluginIds.length === 0) {
    return undefined;
  }
  const bundledPluginIds = new Set(
    resolveBundledProviderCompatPluginIds({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
    }),
  );
  const scopedPluginIds = pluginIds.filter((pluginId) => bundledPluginIds.has(pluginId));
  if (scopedPluginIds.length === 0) {
    return undefined;
  }

  const providers = await resolveRuntimePluginDiscoveryProviders({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env,
    onlyPluginIds: scopedPluginIds,
    includeUntrustedWorkspacePlugins: false,
    requireCompleteDiscoveryEntryCoverage: true,
    discoveryEntriesOnly: true,
    includeManifestModelCatalogProviders: false,
  });

  for (const catalogProvider of providers) {
    const result = await runProviderStaticCatalog({
      provider: catalogProvider,
      config: params.cfg ?? {},
      workspaceDir: params.workspaceDir,
      env,
    });
    const normalized = normalizePluginDiscoveryResult({
      provider: catalogProvider,
      result,
    });
    for (const [providerIdRaw, providerConfig] of Object.entries(normalized)) {
      const providerId = normalizeProviderId(providerIdRaw);
      if (providerId !== provider || !Array.isArray(providerConfig.models)) {
        continue;
      }
      const model = providerConfig.models.find((candidate) =>
        staticModelIdMatches({
          candidateId: candidate.id,
          provider,
          modelId: params.modelId,
        }),
      );
      if (model) {
        return modelFromProviderStaticCatalog({ provider, providerConfig, model });
      }
    }
  }
  return undefined;
}
