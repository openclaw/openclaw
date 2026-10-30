import { isDeepStrictEqual } from "node:util";
import type { Model } from "../llm/types.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { runtimeAuthMetadataState } from "./auth-profiles/runtime-snapshot-owner.js";
import { modelCatalogRouteVariantKey } from "./model-catalog-entry.js";
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
): Pick<PreparedModelCatalogInventory, "catalog" | "discoveryOrigins" | "runtimeModels"> & {
  legacyProviders: ReadonlySet<string>;
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
  const outcomeProviders = new Set(
    catalog.providerOutcomes?.map((outcome) => normalizeProvider(outcome.provider)),
  );
  const legacyProviders = new Set(
    catalog.entries
      .map((entry) => normalizeProvider(entry.provider))
      .filter((provider) => !outcomeProviders.has(provider)),
  );
  if (failed.length === 0) {
    catalog.acceptedDiscoveryOrigins = discoveryOrigins;
    return { catalog, discoveryOrigins, runtimeModels, legacyProviders };
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
      const hasLegacyInventory = inventory?.providers.get(provider)?.legacyAcquired === true;
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
  for (const provider of retainedProviders) {
    if (inventory?.providers.get(provider)?.legacyAcquired) {
      legacyProviders.add(provider);
    }
  }
  const retain = (
    current: ModelCatalogSnapshot["entries"],
    retained: ModelCatalogSnapshot["entries"],
    key: (
      entry: ModelCatalogSnapshot["entries"][number],
    ) => string = createModelCatalogIdentityKeyResolver(),
  ) =>
    // A failed refresh keeps the provider's last-good view, including its configured overlays.
    dedupeByKey(
      [
        ...current.filter((entry) => !retainedProviders.has(normalizeProvider(entry.provider))),
        ...starters
          .filter((entry) => !retainedProviders.has(normalizeProvider(entry.provider)))
          .map((entry) =>
            Object.assign({}, entry, { contextCapacitySource: "unaccepted-starter" as const }),
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
    [...runtimeModels].filter(([provider]) => !retainedProviders.has(normalizeProvider(provider))),
  );
  for (const [provider, models] of inventory?.runtimeModels ?? []) {
    const normalized = normalizeProvider(provider);
    if (retainedProviders.has(normalized)) {
      publishedRuntimeModels.set(provider, models);
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
    legacyProviders,
    discoveryOrigins: published.acceptedDiscoveryOrigins,
  };
}
