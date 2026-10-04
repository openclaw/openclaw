import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import type { preparedProviderCatalogSource } from "./prepared-model-runtime.catalog-source.js";
import {
  filterNativeModelCatalogScopes,
  selectPreparedModelCatalogInventory,
} from "./prepared-model-runtime.full-catalog.js";
import type { PreparedModelCatalogInventory } from "./prepared-model-runtime.types.js";

// Auth usage readers retain the access closure. Keep its predecessor out of that scope.
export function seedPreparedModelCatalogInventory(params: {
  previousInventory: PreparedModelCatalogInventory | undefined;
  agentFacts: PreparedModelRuntimeCatalogAccessParams["agentFacts"];
  pluginFingerprint: string;
  nativeSource: string;
  eligibleProviders: readonly string[];
  providerSources: ReadonlyMap<string, ReturnType<typeof preparedProviderCatalogSource>>;
  normalizeProvider: (provider: string) => string;
}): PreparedModelCatalogInventory | undefined {
  const { previousInventory, agentFacts, nativeSource, normalizeProvider } = params;
  const previousAuth =
    previousInventory && getPreparedModelFullCatalogAuth(previousInventory.catalog);
  const retainedProviders = new Set(
    params.eligibleProviders.filter(
      (provider) =>
        previousInventory?.pluginFingerprint === params.pluginFingerprint &&
        previousInventory.providers.get(provider)?.source ===
          params.providerSources.get(provider) &&
        hasSamePreparedModelCatalogAuth(
          previousAuth,
          agentFacts,
          (id) => normalizeProvider(id) === provider,
        ),
    ),
  );
  if (!previousInventory || !retainedProviders.size) {
    return undefined;
  }
  const inventory: PreparedModelCatalogInventory = {
    ...selectPreparedModelCatalogInventory(previousInventory, (provider) =>
      retainedProviders.has(normalizeProvider(provider)),
    ),
    nativeSource,
  };
  // Native presence markers and empty credentials do not identify an account.
  const identifiedNativeProviders = new Set(
    previousInventory.nativeSource === nativeSource
      ? Object.entries(agentFacts.credentials).flatMap(([provider, credential]) =>
          credential.type === "api_key" && credential.nativeAuth
            ? []
            : [normalizeProvider(provider)],
        )
      : [],
  );
  const retain = (entry: ModelCatalogSnapshot["entries"][number]) =>
    !entry.nativeRuntime || identifiedNativeProviders.has(normalizeProvider(entry.provider));
  inventory.catalog.entries = inventory.catalog.entries.filter(retain);
  inventory.catalog.routeVariants = inventory.catalog.routeVariants.filter(retain);
  inventory.catalog.nativeProviderOutcomes = filterNativeModelCatalogScopes(
    inventory.catalog.nativeProviderOutcomes,
    (provider) => identifiedNativeProviders.has(normalizeProvider(provider)),
  );
  // Host projection rows must be reacquired, not reused as identified account inventory.
  inventory.catalog.nativeHostRows = undefined;
  return inventory;
}
