import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { Model } from "../llm/types.js";
import { resolvePreparedProviderStaticConfigs } from "../plugins/provider-discovery.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { discoverModels } from "./agent-model-discovery.js";
import { getPreparedRuntimeAuthMaterializations } from "./auth-profiles/runtime-materializations.js";
import { runtimeAuthMetadataState } from "./auth-profiles/runtime-snapshot-owner.js";
import { loadBundledProviderStaticCatalogContextModels } from "./embedded-agent-runner/model.static-catalog.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./embedded-agent-runner/model.static-id.js";
import {
  enrichHarnessRows,
  modelCatalogRouteVariantKey,
  modelCatalogRowToEntry,
} from "./model-catalog-entry.js";
import { compareModelCatalogEntries } from "./model-catalog-order.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import {
  copyPreparedModelFullCatalogAuth,
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
  setPreparedModelFullCatalogAuth,
  bindPreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuthScope,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogFacts,
  PreparedModelRuntimeCatalogSource,
} from "./prepared-model-runtime.catalog-contract.js";
import {
  completeConfiguredRuntimeModels,
  prepareConfiguredModelAliases,
} from "./prepared-model-runtime.configured-completion.js";
import {
  acquirePreparedMediaCapabilityProviders,
  buildPreparedPluginModelCatalog,
} from "./prepared-model-runtime.plugin-generation.js";
import type {
  PreparedRuntimeCapabilityModel,
  PreparedModelCatalogInventory,
  PreparedModelCatalogRefreshOptions,
  PreparedNativeModelSelection,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.types.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const fullModelCatalogSnapshots = new WeakSet<ModelCatalogSnapshot>();

function catalogPublicationContent(catalog: ModelCatalogSnapshot) {
  const { pendingProviders: _pending, refreshFailed: _failed, ...inventory } = catalog;
  // Scoped merges move providers, not their model preference order. Compare a grouped view
  // without changing the published order used by model-selection fallbacks.
  const byProvider = <T extends { provider: string }>(rows: readonly T[] = []) =>
    rows.toSorted((left, right) => left.provider.localeCompare(right.provider));
  const byRuntime = <T extends { provider: string }>(
    scopes: Readonly<Record<string, readonly T[]>> | undefined,
  ) =>
    scopes &&
    Object.fromEntries(
      Object.entries(scopes).map(([runtime, rows]) => [runtime, byProvider(rows)]),
    );
  const auth = getPreparedModelFullCatalogAuth(catalog);
  return {
    ...inventory,
    entries: byProvider(catalog.entries),
    routeVariants: byProvider(catalog.routeVariants),
    staticEntries: byProvider(catalog.staticEntries),
    providerOutcomes: byProvider(catalog.providerOutcomes),
    nativeProviderOutcomes: byRuntime(catalog.nativeProviderOutcomes),
    nativeHostRows: byRuntime(catalog.nativeHostRows),
    authoritative: catalog.authoritative !== false,
    full: isPreparedModelCatalogFull(catalog),
    // Workers can observe auth changes before the parent gets a store publication.
    auth: auth && {
      modes: auth.authModes,
      labels: auth.providerAuthLabels,
      metadata: runtimeAuthMetadataState(auth.authStore),
    },
  };
}

/** Keep inventory identity stable across renewals while adopting the latest private auth. */
export function retainPreparedModelCatalogPublication(
  catalog: ModelCatalogSnapshot | undefined,
  previous: ModelCatalogSnapshot | undefined,
): ModelCatalogSnapshot | undefined {
  if (
    !catalog ||
    !previous ||
    !isDeepStrictEqual(catalogPublicationContent(catalog), catalogPublicationContent(previous))
  ) {
    return catalog;
  }
  copyPreparedModelFullCatalogAuth(catalog, previous);
  return previous;
}

/** Builds complete inventory before generation-specific runtime capability projection. */
export async function prepareFullCatalogFacts(
  agentFacts: Pick<
    PreparedModelRuntimeAgentFacts,
    | "input"
    | "env"
    | "templateAuthStorage"
    | "credentials"
    | "configuredModelRefs"
    | "configuredRuntimeModels"
  >,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogMode: PreparedModelRuntimeCatalogMode,
  catalogSource: PreparedModelRuntimeCatalogSource,
  options: { includeNative?: boolean; providerIds?: readonly string[] } = {},
): Promise<PreparedModelRuntimeCatalogFacts> {
  const prepare = async (): Promise<PreparedModelRuntimeCatalogFacts> => {
    const { env, input, templateAuthStorage } = agentFacts;
    const { pluginMetadataSnapshot, preparedStaticProviderCatalog } = pluginGeneration;
    const observedProviders = new Set(
      catalogSource.providerOutcomes?.map(({ provider }) => normalizeProviderId(provider)),
    );
    const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
      config: input.config,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      pluginMetadataSnapshot,
      ...(catalogMode === "static" ? { normalizeModels: false } : {}),
      includePluginCatalogs: true,
      modelsJsonContents: catalogSource.modelsJsonContents,
      pluginCatalogs: catalogSource.pluginCatalogs,
      staticProviderConfigs: Object.fromEntries(
        Object.entries(resolvePreparedProviderStaticConfigs(preparedStaticProviderCatalog)).filter(
          ([provider]) => !observedProviders.has(normalizeProviderId(provider)),
        ),
      ),
    });
    const modelCatalog = await buildPreparedPluginModelCatalog({
      ...options,
      agentFacts,
      catalogMode,
      modelRegistry: templateModelRegistry,
      providerOutcomes: catalogSource.providerOutcomes,
      pluginGeneration,
    });
    const providerStaticModels =
      input.config.models?.mode === "replace"
        ? []
        : (pluginGeneration.providerStaticModels ??
          (await loadBundledProviderStaticCatalogContextModels({
            cfg: input.config,
            env,
            metadataSnapshot: pluginMetadataSnapshot,
            registeredProviders: pluginGeneration.pluginRegistry?.providers,
            providerIds: options.providerIds,
            ...(preparedStaticProviderCatalog ? { preparedStaticProviderCatalog } : {}),
            ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
          })));
    const configuredRuntimeModels = completeConfiguredRuntimeModels(
      agentFacts,
      pluginGeneration,
      templateModelRegistry,
    );
    const providerOutcomes = catalogSource.providerOutcomes ?? [];
    const completeModelCatalog = {
      ...modelCatalog,
      staticEntries:
        input.config.models?.mode === "replace"
          ? []
          : dedupeByKey(providerStaticModels, createModelCatalogIdentityKeyResolver()).map(
              modelCatalogRowToEntry,
            ),
      ...(providerOutcomes.length > 0 ? { providerOutcomes } : {}),
    };
    if (catalogMode === "live") {
      fullModelCatalogSnapshots.add(completeModelCatalog);
    }
    return {
      templateModelRegistry,
      modelCatalog: completeModelCatalog,
      configuredRuntimeModels,
      inlineProviderModels: pluginGeneration.inlineProviderModels,
    };
  };
  return pluginGeneration.pluginRegistry
    ? withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
          pluginRegistry: pluginGeneration.pluginRegistry,
        },
        prepare,
      )
    : prepare();
}

export function mergePreparedNativeCatalog(
  native: ModelCatalogSnapshot,
  providers: ModelCatalogSnapshot,
): ModelCatalogSnapshot {
  const keyOf = createModelCatalogIdentityKeyResolver();
  // Host observations carry their own provenance; inherited API rows are never native facts.
  return {
    ...providers,
    nativeProviderOutcomes: native.nativeProviderOutcomes,
    nativeHostRows: native.nativeHostRows,
    entries: dedupeByKey(
      [
        ...native.entries.filter((entry) => entry.nativeRuntime),
        ...[...providers.entries, ...providers.routeVariants].filter(
          (entry) => !entry.nativeRuntime,
        ),
      ],
      keyOf,
    ),
    routeVariants: dedupeByKey(
      [
        ...native.routeVariants.filter((entry) => entry.nativeRuntime),
        ...providers.routeVariants.filter((entry) => !entry.nativeRuntime),
      ],
      (entry) => modelCatalogRouteVariantKey(entry, keyOf(entry)),
    ),
  };
}

export function filterNativeModelCatalogScopes<T extends { provider: string }>(
  scopes: Readonly<Record<string, readonly T[]>> | undefined,
  includesProvider: (provider: string) => boolean,
): Readonly<Record<string, readonly T[]>> | undefined {
  return (
    scopes &&
    Object.fromEntries(
      Object.entries(scopes).map(([runtime, rows]) => [
        runtime,
        rows.filter(({ provider }) => includesProvider(provider)),
      ]),
    )
  );
}

export function filterPreparedProviderCatalog(
  catalog: ModelCatalogSnapshot,
  includesProvider: (provider: string) => boolean,
): ModelCatalogSnapshot {
  return {
    ...catalog,
    entries: catalog.entries.filter((entry) => includesProvider(entry.provider)),
    routeVariants: catalog.routeVariants.filter((entry) => includesProvider(entry.provider)),
    staticEntries: catalog.staticEntries?.filter((entry) => includesProvider(entry.provider)),
    providerOutcomes: catalog.providerOutcomes?.filter((outcome) =>
      includesProvider(outcome.provider),
    ),
    nativeProviderOutcomes: filterNativeModelCatalogScopes(
      catalog.nativeProviderOutcomes,
      includesProvider,
    ),
    nativeHostRows: filterNativeModelCatalogScopes(catalog.nativeHostRows, includesProvider),
  };
}

export function selectPreparedModelCatalogInventory(
  inventory: PreparedModelCatalogInventory,
  includesProvider: (provider: string) => boolean,
): PreparedModelCatalogInventory {
  return {
    ...inventory,
    catalog: filterPreparedProviderCatalog(inventory.catalog, includesProvider),
    runtimeModels: new Map(
      [...inventory.runtimeModels].filter(([provider]) => includesProvider(provider)),
    ),
    providers: new Map([...inventory.providers].filter(([provider]) => includesProvider(provider))),
    discoveryOrigins: inventory.discoveryOrigins.filter(({ provider }) =>
      includesProvider(provider),
    ),
  };
}

export function mergePreparedModelCatalogInventory(
  previous: PreparedModelCatalogInventory | undefined,
  discovered: PreparedModelCatalogInventory,
  providers: ReadonlySet<string>,
  normalize: (provider: string) => string,
): PreparedModelCatalogInventory {
  const retained =
    previous &&
    selectPreparedModelCatalogInventory(
      previous,
      (provider) => !providers.has(normalize(provider)),
    );
  const catalog = discovered.catalog;
  const before = retained?.catalog;
  const outcomes = [...(before?.providerOutcomes ?? []), ...(catalog.providerOutcomes ?? [])];
  return {
    ...discovered,
    catalog: {
      ...catalog,
      entries: [...(before?.entries ?? []), ...catalog.entries],
      routeVariants: [...(before?.routeVariants ?? []), ...catalog.routeVariants],
      staticEntries: [...(before?.staticEntries ?? []), ...(catalog.staticEntries ?? [])],
      providerOutcomes: outcomes,
      authoritative: outcomes.every((outcome) => outcome.status === "ready"),
    },
    runtimeModels: new Map([...(retained?.runtimeModels ?? []), ...discovered.runtimeModels]),
    providers: new Map([...(retained?.providers ?? []), ...discovered.providers]),
    discoveryOrigins: [...(retained?.discoveryOrigins ?? []), ...discovered.discoveryOrigins],
  };
}

export function prepareModelCatalogPublication(
  discovered: ModelCatalogSnapshot,
  runtimeModels: ReadonlyMap<string, readonly Model[]>,
  inventory:
    | Pick<PreparedModelCatalogInventory, "catalog" | "discoveryOrigins" | "runtimeModels">
    | undefined,
  auth: PreparedModelCatalogAuth,
  normalizeProvider: (provider: string) => string,
): Pick<PreparedModelCatalogInventory, "catalog" | "discoveryOrigins" | "runtimeModels"> {
  // Provider discovery publishes provider rows; the inventory owner merges native observations.
  const catalog: ModelCatalogSnapshot = {
    ...discovered,
    entries: dedupeByKey(
      [...discovered.entries, ...discovered.routeVariants].filter((entry) => !entry.nativeRuntime),
      createModelCatalogIdentityKeyResolver(),
    ),
    routeVariants: discovered.routeVariants.filter((entry) => !entry.nativeRuntime),
  };
  setPreparedModelFullCatalogAuth(catalog, auth);
  const failed = catalog.providerOutcomes?.filter((outcome) => outcome.status !== "ready") ?? [];
  const discoveryOrigins = (catalog.providerOutcomes ?? [])
    .filter((outcome) => outcome.status === "ready")
    .map(({ provider, profileId }) => ({ provider: normalizeProvider(provider), profileId }));
  if (failed.length === 0) {
    return { catalog, discoveryOrigins, runtimeModels };
  }
  const previous = inventory?.catalog;
  const previousAuth = previous && getPreparedModelFullCatalogAuth(previous);
  const starterProviders = new Set(
    failed
      .map(({ provider }) => normalizeProvider(provider))
      .filter((provider) => !discoveryOrigins.some((origin) => origin.provider === provider)),
  );
  const starters = (catalog.staticEntries ?? []).filter(
    (entry) => !entry.nativeRuntime && starterProviders.has(normalizeProvider(entry.provider)),
  );
  const retainedProviders = new Set(
    failed.flatMap((outcome) => {
      const provider = normalizeProvider(outcome.provider);
      const previousOrigins = inventory?.discoveryOrigins.filter(
        (candidate) => normalizeProvider(candidate.provider) === provider,
      );
      if (
        discoveryOrigins.some((origin) => origin.provider === provider) ||
        (!previousOrigins?.length &&
          ![...(previous?.entries ?? []), ...(previous?.routeVariants ?? [])].some(
            (entry) => !entry.nativeRuntime && normalizeProvider(entry.provider) === provider,
          )) ||
        (!previousOrigins?.length &&
          previous?.providerOutcomes?.some(
            (candidate) => normalizeProvider(candidate.provider) === provider,
          )) ||
        !previousAuth ||
        !previousAuth.credentials ||
        !auth.credentials ||
        (outcome.profileId !== undefined &&
          !previousOrigins?.some((candidate) => candidate.profileId === outcome.profileId)) ||
        previousAuth.authModes[provider] !== auth.authModes[provider]
      ) {
        return [];
      }
      return hasSamePreparedModelCatalogAuth(
        previousAuth,
        auth,
        (candidate) => normalizeProvider(candidate) === provider,
      )
        ? [provider]
        : [];
    }),
  );
  const retain = (
    current: ModelCatalogSnapshot["entries"],
    retained: ModelCatalogSnapshot["entries"],
    key: (
      entry: ModelCatalogSnapshot["entries"][number],
    ) => string = createModelCatalogIdentityKeyResolver(),
  ) =>
    dedupeByKey(
      [
        ...[...current, ...starters].filter(
          (entry) => !retainedProviders.has(normalizeProvider(entry.provider)),
        ),
        ...retained.filter(
          (entry) =>
            !entry.nativeRuntime && retainedProviders.has(normalizeProvider(entry.provider)),
        ),
      ],
      key,
    ).toSorted(compareModelCatalogEntries);
  // Route dedupe follows another round of normalization callbacks; acquire its policy afresh.
  const routeKeyOf = createModelCatalogIdentityKeyResolver();
  const published: ModelCatalogSnapshot = {
    ...catalog,
    entries: retain(catalog.entries, previous?.entries ?? []),
    routeVariants: retain(catalog.routeVariants, previous?.routeVariants ?? [], (entry) =>
      JSON.stringify([routeKeyOf(entry), entry.api, entry.baseUrl, entry.nativeRuntime]),
    ),
    authoritative: false,
  };
  setPreparedModelFullCatalogAuth(published, auth);
  return {
    catalog: published,
    runtimeModels: new Map([
      ...[...runtimeModels].filter(
        ([provider]) => !retainedProviders.has(normalizeProvider(provider)),
      ),
      ...[...(inventory?.runtimeModels ?? [])].filter(([provider]) =>
        retainedProviders.has(normalizeProvider(provider)),
      ),
    ]),
    discoveryOrigins: [
      ...discoveryOrigins,
      ...(inventory?.discoveryOrigins ?? []).filter((origin) =>
        retainedProviders.has(normalizeProvider(origin.provider)),
      ),
    ],
  };
}

/** Reprojects retained inventory without carrying capabilities from a retired runtime. */
export function materializePreparedModelCatalog(
  snapshot: ModelCatalogSnapshot,
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[],
  configuredStaticEntries: ModelCatalogSnapshot["staticEntries"] = [],
): ModelCatalogSnapshot {
  // Preserve inventory reads before capability preparation when the snapshot has accessors.
  const materialized = { ...snapshot };
  const sourceEntries = snapshot.entries;
  const identityKey = createModelCatalogIdentityKeyResolver();
  // Re-enrich exact harness observations from this API generation, not a pre-await projection.
  const hostRows = enrichHarnessRows(Object.values(snapshot.nativeHostRows ?? {}).flat(), snapshot);
  const runtimeByKey = new Map(
    runtimeCapabilityModels.map(({ provider, modelId, model }) => [
      identityKey({ provider, id: modelId }),
      modelCatalogRowToEntry(model),
    ]),
  );
  const project = (entries: ModelCatalogSnapshot["entries"]) =>
    entries.map((entry) => {
      const runtime = runtimeByKey.get(identityKey(entry));
      if (!runtime) {
        return entry;
      }
      const thinkingPolicyProvider = runtime.provider;
      if (entry.configuredReasoning !== undefined) {
        return { ...entry, thinkingPolicyProvider };
      }
      const params =
        runtime.params || entry.params ? { ...runtime.params, ...entry.params } : undefined;
      const compat =
        runtime.compat || entry.compat ? { ...runtime.compat, ...entry.compat } : undefined;
      return {
        ...entry,
        thinkingPolicyProvider,
        ...(runtime.reasoning !== undefined ? { reasoning: runtime.reasoning } : {}),
        ...(params ? { params } : {}),
        ...(compat ? { compat } : {}),
      };
    });
  materialized.entries = project(
    hostRows.length
      ? dedupeByKey(
          [...sourceEntries.filter((entry) => entry.nativeRuntime), ...hostRows, ...sourceEntries],
          identityKey,
        )
      : sourceEntries,
  );
  materialized.routeVariants = project(
    hostRows.length
      ? dedupeByKey([...hostRows, ...snapshot.routeVariants], (entry) =>
          modelCatalogRouteVariantKey(entry, identityKey(entry)),
        )
      : snapshot.routeVariants,
  );
  if (snapshot.staticEntries || configuredStaticEntries.length > 0) {
    materialized.staticEntries = project(
      dedupeByKey([...configuredStaticEntries, ...(snapshot.staticEntries ?? [])], identityKey),
    );
  }
  if (isPreparedModelCatalogFull(snapshot)) {
    markPreparedModelCatalogFull(materialized);
  }
  copyPreparedModelFullCatalogAuth(snapshot, materialized);
  return materialized;
}

/** Reports whether a catalog came from the complete prepared-catalog build path. */
export const isPreparedModelCatalogFull = (snapshot: ModelCatalogSnapshot): boolean =>
  fullModelCatalogSnapshots.has(snapshot);

/** Restores process-local provenance after a complete catalog crosses a worker boundary. */
export function markPreparedModelCatalogFull(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  fullModelCatalogSnapshots.add(snapshot);
  return snapshot;
}

export type PreparedModelRuntimeCatalogAccess = Readonly<{
  initialAuth: PreparedModelCatalogAuth;
  isCurrent: () => boolean;
  withRefreshStatus: (catalog: ModelCatalogSnapshot) => ModelCatalogSnapshot;
  readFullModelCatalog: () => ModelCatalogSnapshot | undefined;
  refreshExpiredModelCatalog: () => void;
  readPublishedModels: () => ReadonlyMap<string, readonly Model[]> | undefined;
  loadFullModelCatalog: (
    options?: PreparedModelCatalogRefreshOptions,
  ) => Promise<ModelCatalogSnapshot>;
  loadNativeModelCatalog: (
    selection: PreparedNativeModelSelection,
  ) => Promise<ModelCatalogSnapshot>;
  loadAuth: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>;
}>;
export function createPreparedModelRuntimeSnapshot(
  catalogOwner: PreparedModelRuntimeSnapshot["catalogOwner"],
  agentFacts: PreparedModelRuntimeAgentFacts,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  catalogFacts: PreparedModelRuntimeCatalogFacts,
  catalogAccess: PreparedModelRuntimeCatalogAccess,
  publishedConfig = agentFacts.input.config,
): PreparedModelRuntimeSnapshot {
  const { credentials, input } = agentFacts;
  const {
    mediaCapabilityProviders,
    mediaCapabilityProviderSource,
    messageToolCatalog,
    pluginMetadataSnapshot,
    pluginRegistry,
  } = pluginGeneration;
  const { configuredRuntimeModels, inlineProviderModels, templateModelRegistry } = catalogFacts;
  const modelCatalog = materializePreparedModelCatalog(
    catalogFacts.modelCatalog,
    agentFacts.runtimeCapabilityModels,
    input.config.models?.mode === "replace"
      ? []
      : configuredRuntimeModels.map(({ model }) => modelCatalogRowToEntry(model)),
  );
  prepareModelCatalogThinkingPolicies({
    catalog: modelCatalog,
    metadataSnapshot: pluginMetadataSnapshot,
    providers: pluginRegistry?.providers,
  });
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  const snapshot: PreparedModelRuntimeSnapshot = Object.freeze({
    catalogOwner,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    activeProjectKeys: [],
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: publishedConfig,
    observationConfig: input.config,
    isCurrent: catalogAccess.isCurrent,
    authModes: catalogAccess.initialAuth.authModes,
    metadataSnapshot: pluginMetadataSnapshot,
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    ...(pluginRegistry ? { pluginRegistry } : {}),
    ...(messageToolCatalog ? { messageToolCatalog } : {}),
    ...(mediaCapabilityProviders ? { mediaCapabilityProviders } : {}),
    ...(mediaCapabilityProviderSource && mediaCapabilityProviders
      ? {
          acquireMediaCapabilityProviders: () =>
            acquirePreparedMediaCapabilityProviders(
              mediaCapabilityProviderSource,
              mediaCapabilityProviders,
              pluginRegistry ?? mediaCapabilityProviderSource.registry,
            ),
        }
      : {}),
    modelCatalog: catalogAccess.withRefreshStatus(modelCatalog),
    readFullModelCatalog: catalogAccess.readFullModelCatalog,
    refreshExpiredModelCatalog: catalogAccess.refreshExpiredModelCatalog,
    readPublishedModels: catalogAccess.readPublishedModels,
    loadFullModelCatalog: catalogAccess.loadFullModelCatalog,
    loadNativeModelCatalog: catalogAccess.loadNativeModelCatalog,
    configuredRuntimeModels,
    configuredModelAliases: prepareConfiguredModelAliases(
      agentFacts,
      pluginGeneration,
      templateModelRegistry,
      configuredRuntimeModels,
    ),
    findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
      configuredRuntimeModels,
      pluginMetadataSnapshot,
    ),
    inlineProviderModels,
    createStores,
    routeModelResolutionMemo: new Map<string, Promise<Model>>(),
  });
  bindPreparedModelRuntimeAuth(snapshot, {
    labels: catalogAccess.initialAuth.providerAuthLabels,
    store: catalogAccess.initialAuth.authStore,
    load: catalogAccess.loadAuth,
    materializations: Object.freeze([...getPreparedRuntimeAuthMaterializations(input.agentDir)]),
  });
  return snapshot;
}
