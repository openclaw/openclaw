/**
 * Loads bundled, manifest, and discovered model catalog entries.
 */
import { resolveClaudeFable5ModelIdentity } from "@openclaw/llm-core";
import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { augmentModelCatalogWithProviderPlugins } from "../plugins/provider-runtime.runtime.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { modelSupportsInput as modelCatalogEntrySupportsInput } from "./model-catalog-lookup.js";
import { normalizeCatalogRouteBaseUrl, overlayCatalogMetadata } from "./model-catalog-metadata.js";
import { assignProviderModelOrder, compareModelCatalogEntries } from "./model-catalog-order.js";
import { createPreparedModelCatalogProviderNormalizer } from "./model-catalog-provider-normalizer.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createConfiguredProviderCatalogModelIdNormalizer } from "./model-ref-shared.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { resolveModelCatalogIdentityKey } from "./openai-model-routes.js";
import type { AuthStorageData, ModelRegistry } from "./sessions/index.js";

const log = createSubsystemLogger("model-catalog");

export type {
  ModelCatalogEntry,
  ModelCatalogSnapshot,
  ModelInputType,
} from "./model-catalog.types.js";
export {
  findModelCatalogEntry,
  findModelInCatalog,
  modelSupportsInput,
} from "./model-catalog-lookup.js";

export type BuildPreparedModelCatalogParams = {
  agentDir: string;
  authCredentials: Readonly<AuthStorageData>;
  config: OpenClawConfig;
  modelRegistry: ModelRegistry;
  readOnly?: boolean;
  includeProviderPluginAugmentation?: boolean;
  providerIds?: readonly string[];
  metadataSnapshot: PluginMetadataSnapshot;
  providerOutcomes?: ModelCatalogSnapshot["providerOutcomes"];
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

let hasLoggedModelCatalogError = false;
type ManifestModelCatalogCacheEntry = {
  snapshot: PluginMetadataSnapshot;
  rows: ModelCatalogEntry[];
};
let manifestModelCatalogCache = new WeakMap<OpenClawConfig, ManifestModelCatalogCacheEntry>();
const loadModelSuppression = createLazyPromise(() => import("./model-suppression.js"));
const loadProviderApiKeyResolver = createLazyPromise(
  () => import("./models-config.providers.secrets.js"),
);

export function resetModelCatalogBuilderCacheForTest() {
  manifestModelCatalogCache = new WeakMap();
  hasLoggedModelCatalogError = false;
}

function normalizeCatalogEntryContract(entry: ModelCatalogEntry): ModelCatalogEntry {
  if (
    entry.api === "anthropic-messages" &&
    resolveClaudeFable5ModelIdentity({ id: entry.id, params: entry.params })
  ) {
    return { ...entry, reasoning: true };
  }
  return entry;
}

function mergeCatalogEntries(
  models: ModelCatalogEntry[],
  entries: ModelCatalogEntry[],
  options?: {
    catalogRoutes?: ModelCatalogRouteVariantCollector;
    preserveBaseCompat?: boolean;
  },
): void {
  const indexByKey = new Map(
    models.map((entry, index) => [resolveModelCatalogIdentityKey(entry), index]),
  );
  for (const entry of entries) {
    const key = resolveModelCatalogIdentityKey(entry);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      models.push(entry);
      indexByKey.set(key, models.length - 1);
      continue;
    }
    const existing = models.at(existingIndex);
    if (existing) {
      // Logical rows can represent a sibling route; capabilities must come
      // from the exact catalog variant selected by config, not that sibling.
      const routes = options?.catalogRoutes;
      const routeIndex = options?.preserveBaseCompat
        ? routes?.indexByKey.get(catalogRouteVariantKey(entry))
        : undefined;
      const catalogRoute = routeIndex === undefined ? undefined : routes?.entries[routeIndex];
      models[existingIndex] = overlayCatalogMetadata(catalogRoute ?? existing, entry, options);
    }
  }
}

function catalogRouteVariantKey(entry: ModelCatalogEntry): string {
  return [
    resolveModelCatalogIdentityKey(entry),
    entry.api ?? "",
    normalizeCatalogRouteBaseUrl(entry.baseUrl) ?? "",
  ].join("\u0000");
}

type ModelCatalogRouteVariantCollector = {
  entries: ModelCatalogEntry[];
  indexByKey: Map<string, number>;
};

function createModelCatalogRouteVariantCollector(): ModelCatalogRouteVariantCollector {
  return { entries: [], indexByKey: new Map() };
}

function mergeCatalogRouteVariants(
  collector: ModelCatalogRouteVariantCollector,
  entries: readonly ModelCatalogEntry[],
  options?: { preserveBaseCompat?: boolean },
): void {
  for (const entry of entries) {
    const key = catalogRouteVariantKey(entry);
    const existingIndex = collector.indexByKey.get(key);
    if (existingIndex === undefined) {
      collector.entries.push(entry);
      collector.indexByKey.set(key, collector.entries.length - 1);
      continue;
    }
    const existingEntry = collector.entries[existingIndex];
    if (existingEntry === undefined) {
      continue;
    }
    collector.entries[existingIndex] = overlayCatalogMetadata(existingEntry, entry, options);
  }
}

function createModelCatalogSnapshot(
  entries: ModelCatalogEntry[],
  routeVariants: ModelCatalogRouteVariantCollector,
): ModelCatalogSnapshot {
  return {
    entries: sortModelCatalogEntries(entries),
    routeVariants: sortModelCatalogEntries(routeVariants.entries),
  };
}

function resolveEligibleManifestCatalogPlugins(
  snapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): PluginMetadataSnapshot["plugins"] {
  return snapshot.plugins.filter(
    (plugin) =>
      plugin.modelCatalog &&
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config,
      }),
  );
}

export function loadManifestModelCatalog(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  fallbackToMetadataScan?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
}): ModelCatalogEntry[] {
  if (params.config.models?.mode === "replace") {
    return [];
  }
  const resolvedSnapshot =
    params.metadataSnapshot ??
    (params.fallbackToMetadataScan === false
      ? getCurrentPluginMetadataSnapshot({
          config: params.config,
          env: params.env,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.workspaceDir === undefined ? { allowWorkspaceScopedSnapshot: true } : {}),
        })
      : resolvePluginMetadataSnapshot({
          config: params.config,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
          env: params.env ?? process.env,
          allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
        }));
  if (!resolvedSnapshot) {
    return [];
  }
  const cached = manifestModelCatalogCache.get(params.config);
  if (cached?.snapshot === resolvedSnapshot) {
    return cached.rows;
  }
  const plugins = resolveEligibleManifestCatalogPlugins(resolvedSnapshot, params.config);
  const plan = planEffectiveModelCatalogRows({
    registry: { plugins },
    config: params.config,
  });
  const providerOrderByKey = new Map<string, number>();
  for (const plugin of plugins) {
    for (const [provider, providerCatalog] of Object.entries(
      plugin.modelCatalog?.providers ?? {},
    )) {
      providerCatalog.models.forEach((model, providerOrder) => {
        const key = buildModelCatalogMergeKey(provider, model.id);
        if (!providerOrderByKey.has(key)) {
          providerOrderByKey.set(key, providerOrder);
        }
      });
    }
  }
  const rows = plan.rows.map((row) => {
    const entry = modelCatalogRowToEntry(row);
    const providerOrder = providerOrderByKey.get(buildModelCatalogMergeKey(row.provider, row.id));
    if (providerOrder !== undefined) {
      entry.providerOrder = providerOrder;
    }
    return entry;
  });
  manifestModelCatalogCache.set(params.config, { snapshot: resolvedSnapshot, rows });
  return rows;
}

function sortModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return entries.map(normalizeCatalogEntryContract).toSorted(compareModelCatalogEntries);
}

/** Builds the catalog once for a lifecycle generation. No request-time discovery or cache IO. */
export async function buildPreparedModelCatalogSnapshot(
  params: BuildPreparedModelCatalogParams,
): Promise<ModelCatalogSnapshot> {
  const models: ModelCatalogEntry[] = [];
  const routeVariants = createModelCatalogRouteVariantCollector();
  const cfg = params.config;
  const env = params.env ?? process.env;
  const timingEnabled = isDiagnosticFlagEnabled("ingress.timing", cfg);
  const startMs = timingEnabled ? Date.now() : 0;
  const logStage = (stage: string, extra?: string) => {
    if (!timingEnabled) {
      return;
    }
    const suffix = extra ? ` ${extra}` : "";
    log.info(`model-catalog stage=${stage} elapsedMs=${Date.now() - startMs}${suffix}`);
  };
  try {
    const workspaceDir = params.workspaceDir;
    const manifestMetadataSnapshot = params.metadataSnapshot;
    const normalizeModelId = createConfiguredProviderCatalogModelIdNormalizer({
      manifestPlugins: manifestMetadataSnapshot,
    });
    const normalizeProvider = createPreparedModelCatalogProviderNormalizer(
      manifestMetadataSnapshot,
      cfg,
      env,
    );
    const observedProviders = new Set(
      params.providerOutcomes?.map((outcome) => normalizeProvider(outcome.provider)),
    );
    const { buildShouldSuppressBuiltInModelCore } = await loadModelSuppression();
    logStage("catalog-deps-ready");
    const entries = params.modelRegistry.getAll();
    const declaredManifestModels = loadManifestModelCatalog({
      config: cfg,
      env,
      metadataSnapshot: manifestMetadataSnapshot,
    });
    logStage("registry-read", `entries=${entries.length}`);

    const shouldSuppressBuiltInModel = buildShouldSuppressBuiltInModelCore({ config: cfg });
    logStage("suppress-resolver-ready");

    for (const entry of entries) {
      // Registry IDs name executable models. Reinterpreting them as input
      // aliases would move their capabilities onto another model.
      const id = entry.id.trim();
      if (!id) {
        continue;
      }
      const rawProvider = entry.provider.trim();
      if (!rawProvider) {
        continue;
      }
      const provider = normalizeProvider(rawProvider);
      const baseUrl = entry.baseUrl?.trim();
      if (shouldSuppressBuiltInModel({ provider, id, baseUrl })) {
        continue;
      }
      const model = modelCatalogRowToEntry({
        ...entry,
        id,
        name: entry.name.trim() || id,
        provider,
        baseUrl,
      });
      models.push(model);
    }
    // Gateway startup may publish registry rows without runtime augmentation.
    // Rank them here so both static startup and later live enrichment preserve
    // provider-owned order instead of falling back to model-id sorting.
    const orderedRegistryModels = assignProviderModelOrder(models, declaredManifestModels, {
      appendUnknown: false,
    });
    models.splice(0, models.length, ...orderedRegistryModels);
    mergeCatalogRouteVariants(routeVariants, orderedRegistryModels);
    const supplementalManifestPlan = planEffectiveModelCatalogRows({
      registry: {
        plugins: resolveEligibleManifestCatalogPlugins(manifestMetadataSnapshot, cfg),
      },
      config: cfg,
      selection: "supplemental",
    });
    const dynamicManifestKeys = new Set(
      supplementalManifestPlan.entries.flatMap((entry) =>
        entry.discovery === "runtime" || entry.discovery === "refreshable"
          ? entry.rows.map((row) => buildModelCatalogMergeKey(row.provider, row.id))
          : [],
      ),
    );
    const runtimeDiscoveryProviders = new Set([
      ...observedProviders,
      ...supplementalManifestPlan.entries.flatMap((entry) =>
        entry.discovery === "runtime" || entry.discovery === "refreshable"
          ? [normalizeProviderId(entry.provider)]
          : [],
      ),
    ]);
    // Runtime declarations describe possible models, not account entitlement.
    // Only live registry or refreshed rows may publish those provider models.
    const discoveredKeys = new Set(models.map(resolveModelCatalogIdentityKey));
    const manifestModels = declaredManifestModels.filter(
      (entry) =>
        (params.includeProviderPluginAugmentation === false ||
          !dynamicManifestKeys.has(buildModelCatalogMergeKey(entry.provider, entry.id))) &&
        (!observedProviders.has(entry.provider) ||
          discoveredKeys.has(resolveModelCatalogIdentityKey(entry))),
    );
    mergeCatalogRouteVariants(routeVariants, manifestModels);
    mergeCatalogEntries(models, manifestModels);
    logStage("manifest-models-merged", `entries=${models.length}`);
    const configuredCatalogParams = {
      cfg,
      catalog: orderedRegistryModels,
      manifestPlugins: manifestMetadataSnapshot,
    };
    const configuredModels = buildConfiguredModelCatalog(configuredCatalogParams);
    logStage("configured-models-prepared", `entries=${models.length}`);

    if (
      cfg.models?.mode !== "replace" &&
      !params.readOnly &&
      params.includeProviderPluginAugmentation !== false
    ) {
      const augmentEntries = [...models];
      if (configuredModels.length > 0) {
        mergeCatalogEntries(augmentEntries, configuredModels, {
          catalogRoutes: routeVariants,
          preserveBaseCompat: true,
        });
      }
      const { createProviderApiKeyResolverFromPreparedCredentials } =
        await loadProviderApiKeyResolver();
      const resolveProviderApiKeyForProvider = createProviderApiKeyResolverFromPreparedCredentials(
        env,
        params.authCredentials,
        cfg,
        workspaceDir,
      );
      const resolveProviderApiKey = (providerId?: string) =>
        providerId?.trim()
          ? resolveProviderApiKeyForProvider(providerId)
          : { apiKey: undefined, discoveryApiKey: undefined };
      const supplemental = await augmentModelCatalogWithProviderPlugins({
        providerIds: params.providerIds,
        config: cfg,
        workspaceDir,
        env,
        metadataSnapshot: manifestMetadataSnapshot,
        context: {
          config: cfg,
          agentDir: params.agentDir,
          workspaceDir,
          env,
          resolveProviderApiKey,
          entries: augmentEntries,
        },
      });
      if (supplemental.length > 0) {
        // Explicitly configured rows are user-authorized even when live
        // discovery omits them; compare emitted identities to preserve their routes.
        const accountVisibleModelKeys = new Set(
          [...models, ...configuredModels].map(resolveModelCatalogIdentityKey),
        );
        const normalizedSupplemental: ModelCatalogEntry[] = [];
        for (const entry of supplemental) {
          const provider = normalizeProvider(entry.provider);
          const owners = manifestMetadataSnapshot.owners;
          const pluginIds =
            owners.modelCatalogProviders.get(provider) ?? owners.providers.get(provider);
          const pluginId = pluginIds?.length === 1 ? pluginIds[0] : undefined;
          const plugin = pluginId ? manifestMetadataSnapshot.byPluginId.get(pluginId) : undefined;
          if (!isProviderCatalogSourceAllowed({ provider, config: cfg, plugin })) {
            continue;
          }
          const id = normalizeModelId(provider, entry.id);
          // Account-discovered providers own the visible model set. Synthetic
          // metadata can enrich an available or explicitly configured model,
          // but must never advertise a model the account did not discover.
          if (
            runtimeDiscoveryProviders.has(normalizeProviderId(provider)) &&
            !accountVisibleModelKeys.has(resolveModelCatalogIdentityKey({ provider, id }))
          ) {
            continue;
          }
          normalizedSupplemental.push({
            ...entry,
            provider,
            id,
          });
        }
        // Manifest ranks are provider-owned policy. Live discovery enriches
        // those rows and appends unknown models without replacing the ranking.
        const orderedSupplemental = assignProviderModelOrder(normalizedSupplemental, [
          ...declaredManifestModels,
          ...models,
        ]);
        mergeCatalogRouteVariants(routeVariants, orderedSupplemental);
        mergeCatalogEntries(models, orderedSupplemental);
      }
    }
    logStage("plugin-models-merged", `entries=${models.length}`);

    if (configuredModels.length > 0) {
      const configuredOverrides = buildConfiguredModelCatalog(configuredCatalogParams);
      // Augmentation may mutate borrowed rows. Reindex before configured overlays so
      // route lookup keeps the first current donor, including duplicate keys.
      routeVariants.indexByKey.clear();
      routeVariants.entries.forEach((entry, index) => {
        const key = catalogRouteVariantKey(entry);
        if (!routeVariants.indexByKey.has(key)) {
          routeVariants.indexByKey.set(key, index);
        }
      });
      mergeCatalogEntries(models, configuredOverrides, {
        catalogRoutes: routeVariants,
        preserveBaseCompat: true,
      });
      mergeCatalogRouteVariants(routeVariants, configuredOverrides, { preserveBaseCompat: true });
    }
    logStage("configured-models-finalized", `entries=${models.length}`);

    const snapshot = createModelCatalogSnapshot(models, routeVariants);
    logStage("complete", `entries=${snapshot.entries.length}`);
    return params.providerOutcomes
      ? {
          ...snapshot,
          authoritative: params.providerOutcomes.every((outcome) => outcome.status === "ready"),
        }
      : snapshot;
  } catch (error) {
    if (!hasLoggedModelCatalogError) {
      hasLoggedModelCatalogError = true;
      log.warn(`Failed to load model catalog: ${String(error)}`);
    }
    throw error;
  }
}

/**
 * Check if a model supports image input based on its catalog entry.
 */
export function modelSupportsVision(entry: ModelCatalogEntry | undefined): boolean {
  return modelCatalogEntrySupportsInput(entry, "image");
}
