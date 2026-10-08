import type { Model } from "../llm/types.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { modelCatalogRouteVariantKey, modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { compareModelCatalogEntries } from "./model-catalog-order.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import {
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
  setPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelCatalogInventory } from "./prepared-model-runtime.types.js";

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
    const accepted = acceptedRows.get(provider) ?? new Set<string>();
    for (const key of keys) {
      accepted.add(key);
    }
    acceptedRows.set(provider, accepted);
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
        ...starters.filter((entry) => !retainedProviders.has(normalizeProvider(entry.provider))),
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
  const published: ModelCatalogSnapshot = {
    ...catalog,
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
