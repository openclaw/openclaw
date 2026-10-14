import { isDeepStrictEqual } from "node:util";
import type { Model } from "../llm/types.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { runtimeAuthMetadataState } from "./auth-profiles/runtime-snapshot-owner.js";
import { modelCatalogRouteVariantKey, modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { compareModelCatalogEntries } from "./model-catalog-order.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import {
  copyPreparedModelFullCatalogAuth,
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelCatalogInventory } from "./prepared-model-runtime.types.js";

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
  const includes = (entry: { provider: string }) => includesProvider(entry.provider);
  return {
    ...catalog,
    entries: catalog.entries.filter(includes),
    routeVariants: catalog.routeVariants.filter(includes),
    staticEntries: catalog.staticEntries?.filter(includes),
    acceptedDiscoveryOrigins: catalog.acceptedDiscoveryOrigins?.filter(({ provider }) =>
      includesProvider(provider),
    ),
    providerOutcomes: catalog.providerOutcomes?.filter(includes),
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

export function prepareModelCatalogPublication(
  discovered: ModelCatalogSnapshot,
  runtimeModels: ReadonlyMap<string, readonly Model[]>,
  inventory:
    | Pick<
        PreparedModelCatalogInventory,
        "catalog" | "discoveryOrigins" | "runtimeModels" | "providers"
      >
    | undefined,
  auth: PreparedModelCatalogAuth,
  normalizeProvider: (provider: string) => string,
  hookRows: ReadonlyMap<string, ReadonlySet<string>>,
): Pick<PreparedModelCatalogInventory, "catalog" | "discoveryOrigins" | "runtimeModels"> & {
  legacyRows: ReadonlyMap<string, ReadonlySet<string>>;
} {
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
  const identityKey = createModelCatalogIdentityKeyResolver();
  const rowKey = (entry: ModelCatalogSnapshot["entries"][number]) =>
    modelCatalogRouteVariantKey(
      entry,
      identityKey({ provider: normalizeProvider(entry.provider), id: entry.id }),
    );
  const acceptedRows = new Map<string, Set<string>>();
  for (const [owner, keys] of hookRows) {
    const provider = normalizeProvider(owner);
    acceptedRows.set(provider, new Set([...(acceptedRows.get(provider) ?? []), ...keys]));
  }
  const outcomeProviders = new Set(
    catalog.providerOutcomes?.map((outcome) => normalizeProvider(outcome.provider)),
  );
  const legacyRows = new Map<string, Set<string>>();
  for (const entry of [...catalog.entries, ...catalog.routeVariants]) {
    const provider = normalizeProvider(entry.provider);
    const key = rowKey(entry);
    if (outcomeProviders.has(provider) || !acceptedRows.get(provider)?.has(key)) {
      continue;
    }
    const keys = legacyRows.get(provider) ?? new Set<string>();
    keys.add(key);
    legacyRows.set(provider, keys);
  }
  if (failed.length === 0) {
    catalog.acceptedDiscoveryOrigins = discoveryOrigins;
    return { catalog, discoveryOrigins, runtimeModels, legacyRows };
  }
  const previous = inventory?.catalog;
  const previousAuth = previous && getPreparedModelFullCatalogAuth(previous);
  const previousLegacyRows = new Map<string, Set<string>>();
  for (const entry of [...(previous?.entries ?? []), ...(previous?.routeVariants ?? [])]) {
    const provider = normalizeProvider(entry.provider);
    const key = rowKey(entry);
    if (!entry.nativeRuntime && inventory?.providers.get(provider)?.legacyRows?.has(key)) {
      const keys = previousLegacyRows.get(provider) ?? new Set<string>();
      keys.add(key);
      previousLegacyRows.set(provider, keys);
    }
  }
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
      const hasLegacyInventory = Boolean(previousLegacyRows.get(provider)?.size);
      if (
        discoveryOrigins.some((origin) => origin.provider === provider) ||
        // A completed legacy acquisition can retain rows without claiming live discovery.
        (!previousOrigins?.length && !hasLegacyInventory) ||
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
  const discoveredRetainedProviders = new Set(
    [...retainedProviders].filter((provider) =>
      inventory?.discoveryOrigins.some((origin) => normalizeProvider(origin.provider) === provider),
    ),
  );
  for (const [provider, keys] of previousLegacyRows) {
    if (retainedProviders.has(provider) && !discoveredRetainedProviders.has(provider)) {
      legacyRows.set(provider, keys);
    }
  }
  const retain = (
    current: ModelCatalogSnapshot["entries"],
    retained: ModelCatalogSnapshot["entries"],
    key: (
      entry: ModelCatalogSnapshot["entries"][number],
    ) => string = createModelCatalogIdentityKeyResolver(),
  ) =>
    dedupeByKey(
      [
        ...current.filter(
          (entry) =>
            !discoveredRetainedProviders.has(normalizeProvider(entry.provider)) &&
            !(
              retainedProviders.has(normalizeProvider(entry.provider)) &&
              legacyRows.get(normalizeProvider(entry.provider))?.has(rowKey(entry))
            ),
        ),
        ...starters
          .filter((entry) => !retainedProviders.has(normalizeProvider(entry.provider)))
          .map((entry) =>
            Object.assign({}, entry, { contextCapacitySource: "unaccepted-starter" as const }),
          ),
        ...retained.filter(
          (entry) =>
            !entry.nativeRuntime &&
            retainedProviders.has(normalizeProvider(entry.provider)) &&
            (discoveredRetainedProviders.has(normalizeProvider(entry.provider)) ||
              legacyRows.get(normalizeProvider(entry.provider))?.has(rowKey(entry))),
        ),
      ],
      key,
    ).toSorted(compareModelCatalogEntries);
  // Route dedupe follows another round of normalization callbacks; acquire its policy afresh.
  const routeKeyOf = createModelCatalogIdentityKeyResolver();
  const providerOutcomes: NonNullable<ModelCatalogSnapshot["providerOutcomes"]>[number][] = [];
  for (const outcome of catalog.providerOutcomes ?? []) {
    const accepted = previous?.providerOutcomes?.find(
      (candidate) => candidate.provider === outcome.provider,
    );
    providerOutcomes.push(
      outcome.status !== "ready" &&
        retainedProviders.has(normalizeProvider(outcome.provider)) &&
        accepted?.listedModelIds !== undefined
        ? { ...outcome, listedModelIds: accepted.listedModelIds }
        : outcome,
    );
  }
  const published: ModelCatalogSnapshot = {
    ...catalog,
    providerOutcomes,
    entries: retain(catalog.entries, previous?.entries ?? []),
    routeVariants: retain(catalog.routeVariants, previous?.routeVariants ?? [], (entry) =>
      JSON.stringify([routeKeyOf(entry), entry.api, entry.baseUrl, entry.nativeRuntime]),
    ),
    authoritative: false,
  };
  setPreparedModelFullCatalogAuth(published, auth);
  const publishedRuntimeModels = new Map(
    [...runtimeModels].filter(
      ([provider]) => !discoveredRetainedProviders.has(normalizeProvider(provider)),
    ),
  );
  for (const [provider, models] of inventory?.runtimeModels ?? []) {
    const normalized = normalizeProvider(provider);
    if (discoveredRetainedProviders.has(normalized)) {
      publishedRuntimeModels.set(provider, models);
    } else if (retainedProviders.has(normalized)) {
      publishedRuntimeModels.set(
        provider,
        dedupeByKey(
          [
            ...(publishedRuntimeModels.get(provider) ?? []).filter(
              (model) => !legacyRows.get(normalized)?.has(rowKey(modelCatalogRowToEntry(model))),
            ),
            ...models.filter((model) =>
              legacyRows.get(normalized)?.has(rowKey(modelCatalogRowToEntry(model))),
            ),
          ],
          (model) => rowKey(modelCatalogRowToEntry(model)),
        ),
      );
    }
  }
  published.acceptedDiscoveryOrigins = [
    ...discoveryOrigins,
    ...(inventory?.discoveryOrigins ?? []).filter((origin) =>
      retainedProviders.has(normalizeProvider(origin.provider)),
    ),
  ];
  return {
    catalog: published,
    runtimeModels: publishedRuntimeModels,
    legacyRows,
    discoveryOrigins: published.acceptedDiscoveryOrigins,
  };
}
