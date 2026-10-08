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
import { augmentPreparedModelCatalogWithAgentHarness } from "./harness/model-catalog.js";
import {
  enrichHarnessRows,
  modelCatalogRouteVariantKey,
  modelCatalogRowToEntry,
} from "./model-catalog-entry.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import { buildPreparedModelCatalogSnapshot } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import {
  copyPreparedModelFullCatalogAuth,
  getPreparedModelFullCatalogAuth,
  bindPreparedModelRuntimeAuth,
  type PreparedModelRuntimeAuth,
  type PreparedAccountCatalogAccess,
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
import { acquirePreparedMediaCapabilityProviders } from "./prepared-model-runtime.plugin-generation.js";
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
    acceptedDiscoveryOrigins: catalog.acceptedDiscoveryOrigins?.toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        (left.profileId ?? "").localeCompare(right.profileId ?? ""),
    ),
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
): Promise<PreparedModelRuntimeCatalogFacts & { catalogModels: readonly Model[] }> {
  const prepare = async () => {
    const { env, input, templateAuthStorage } = agentFacts;
    const { pluginMetadataSnapshot, pluginRegistry, preparedStaticProviderCatalog } =
      pluginGeneration;
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
    const catalogModels = templateModelRegistry.getAll();
    const snapshot = await buildPreparedModelCatalogSnapshot({
      agentDir: input.agentDir,
      authCredentials: agentFacts.credentials,
      config: input.config,
      models: catalogModels,
      metadataSnapshot: pluginMetadataSnapshot,
      providerOutcomes: catalogSource.providerOutcomes,
      includeProviderPluginAugmentation: catalogMode === "live",
      providerIds: options.providerIds,
      ...(input.env ? { env: input.env } : {}),
      ...(input.readOnly ? { readOnly: true } : {}),
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
    const modelCatalog =
      catalogMode === "live" && options.includeNative !== false
        ? await augmentPreparedModelCatalogWithAgentHarness({ input, snapshot, pluginRegistry })
        : snapshot;
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
      catalogModels,
      modelCatalog: completeModelCatalog,
      configuredRuntimeModels,
      inlineProviderModels: pluginGeneration.inlineProviderModels,
    };
  };
  return withPluginRuntimeGenerationScope(
    {
      metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: pluginGeneration.pluginRegistry,
    },
    prepare,
  );
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
    acceptedDiscoveryOrigins: catalog.acceptedDiscoveryOrigins?.filter(({ provider }) =>
      includesProvider(provider),
    ),
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
      acceptedDiscoveryOrigins: [
        ...(retained?.discoveryOrigins ?? []),
        ...discovered.discoveryOrigins,
      ],
      authoritative: outcomes.every((outcome) => outcome.status === "ready"),
    },
    runtimeModels: new Map([...(retained?.runtimeModels ?? []), ...discovered.runtimeModels]),
    providers: new Map([...(retained?.providers ?? []), ...discovered.providers]),
    discoveryOrigins: [...(retained?.discoveryOrigins ?? []), ...discovered.discoveryOrigins],
  };
}

/** Reprojects retained inventory without carrying capabilities from a retired runtime. */
export function materializePreparedModelCatalog(
  snapshot: ModelCatalogSnapshot,
  runtimeCapabilityModels: readonly PreparedRuntimeCapabilityModel[],
  configuredStaticEntries: ModelCatalogSnapshot["staticEntries"] = [],
  acceptedDiscoveryProviders: ReadonlySet<string> = new Set(),
): ModelCatalogSnapshot {
  // Preserve inventory reads before capability preparation when the snapshot has accessors.
  const materialized = { ...snapshot };
  const sourceEntries = snapshot.entries;
  const sourceRoutes = [...sourceEntries, ...snapshot.routeVariants];
  // The inventory owner has already validated source, account and generation. Only a
  // provider-marked unknown-model estimate may yield to that accepted inventory;
  // curated static metadata and authored caps keep their existing minimum semantics.
  const supersedingEntry = (entry: ModelCatalogSnapshot["entries"][number]) =>
    acceptedDiscoveryProviders.has(normalizeProviderId(entry.provider)) &&
    entry.contextWindowSource === "synthetic"
      ? sourceRoutes.find(
          (accepted) =>
            !accepted.nativeRuntime &&
            accepted.provider === entry.provider &&
            accepted.id === entry.id &&
            Boolean(accepted.api) &&
            accepted.api === entry.api &&
            modelTransportRoutesMatch(accepted, entry) &&
            // Only a reported limit grants replacement: a real prompt limit, or a native
            // window that is not itself a provider estimate.
            (accepted.contextTokens ??
              (accepted.contextWindowSource === "synthetic" ? undefined : accepted.contextWindow) ??
              0) > 0,
        )
      : undefined;
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
      dedupeByKey(
        [...configuredStaticEntries, ...(snapshot.staticEntries ?? [])].flatMap((entry) => {
          const accepted = supersedingEntry(entry);
          if (!accepted) {
            return [entry];
          }
          return entry.contextWindows?.length
            ? [
                overlayCatalogMetadata(accepted, {
                  provider: entry.provider,
                  id: entry.id,
                  name: entry.name,
                  contextWindows: entry.contextWindows,
                  contextWindowDefault: entry.contextWindowDefault,
                }),
              ]
            : [];
        }),
        identityKey,
      ),
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
  accountCatalog?: PreparedAccountCatalogAccess;
  isCurrent: () => boolean;
  withRefreshStatus: (catalog: ModelCatalogSnapshot) => ModelCatalogSnapshot;
  readFullModelCatalog: () => ModelCatalogSnapshot | undefined;
  recheckNativeLogin: () => void;
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
    pluginRegistry,
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
    accountCatalog: catalogAccess.accountCatalog,
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
    recheckNativeLogin: catalogAccess.recheckNativeLogin,
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
