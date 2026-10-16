import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  getPreparedModelFullCatalogAuth,
  hasSamePreparedModelCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type {
  PreparedModelRuntimeAgentFacts,
  PreparedModelRuntimeCatalogAccessParams,
} from "./prepared-model-runtime.catalog-contract.js";
import {
  filterNativeModelCatalogScopes,
  selectPreparedModelCatalogInventory,
} from "./prepared-model-runtime.catalog-publication.js";
import { preparedModelInventoryKey } from "./prepared-model-runtime.facts.js";
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.fingerprint.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

export function preparedProviderCatalogSource(
  facts: PreparedModelRuntimeAgentFacts,
  generation: PreparedModelRuntimePluginGeneration,
  provider: string,
  normalize: (provider: string) => string,
): string {
  const { config } = facts.input;
  const pluginIds = generation.pluginMetadataSnapshot.owners.providers.get(provider) ?? [];
  const providerEntries = <T>(entries: Record<string, T> | undefined) =>
    Object.fromEntries(Object.entries(entries ?? {}).filter(([id]) => normalize(id) === provider));
  return fingerprintPreparedRuntimeFacts({
    // An upgraded owning plugin may list different models; its rows are not carried across.
    pluginPackages: generation.pluginMetadataSnapshot.index.plugins
      .filter(({ pluginId }) => pluginIds.includes(pluginId))
      .map(({ pluginId, packageVersion, installRecordHash }) => [
        pluginId,
        packageVersion,
        installRecordHash,
      ]),
    remoteCatalogSource: generation.remoteCatalog?.sourceUrl,
    remoteCatalogRevision: generation.remoteCatalog?.revision,
    models: { ...config.models, providers: providerEntries(config.models?.providers) },
    auth: {
      profiles: Object.fromEntries(
        Object.entries(config.auth?.profiles ?? {}).filter(
          ([, profile]) => normalize(profile.provider) === provider,
        ),
      ),
      order: providerEntries(config.auth?.order),
    },
    plugins: {
      ...config.plugins,
      allow: config.plugins?.allow?.filter((id) => pluginIds.includes(id)),
      deny: config.plugins?.deny?.filter((id) => pluginIds.includes(id)),
      entries: Object.fromEntries(pluginIds.map((id) => [id, config.plugins?.entries?.[id]])),
    },
    env: { config: config.env, runtime: facts.env },
  });
}

export function preparedProviderCatalogCredentials(
  source: Pick<PreparedModelCatalogAuth, "authStore" | "credentials">,
  provider: string,
  normalize: (provider: string) => string,
): string {
  const { authStore, credentials } = source;
  return fingerprintPreparedRuntimeFacts({
    profiles: Object.fromEntries(
      Object.entries(authStore.profiles).filter(
        ([, profile]) => normalize(profile.provider) === provider,
      ),
    ),
    credentials: Object.fromEntries(
      Object.entries(credentials ?? {}).filter(([id]) => normalize(id) === provider),
    ),
    order: Object.fromEntries(
      Object.entries(authStore.order ?? {}).filter(([id]) => normalize(id) === provider),
    ),
  });
}

/** Reuse only catalog rows whose provider identity and credentials survived publication. */
export function prepareRetainedProviderCatalog(
  params: PreparedModelRuntimeCatalogAccessParams,
  normalizeProvider: (provider: string) => string,
  eligibleProviders: readonly string[],
) {
  const facts = params.agentFacts;
  const inventoryKey = preparedModelInventoryKey(facts.input);
  const nativeSource = fingerprintPreparedRuntimeFacts({
    runtimePluginSelections: facts.input.runtimePluginSelections,
    config: params.nativeConfigFingerprint,
    configuredModelRefs: facts.configuredModelRefs,
  });
  const pluginFingerprint = resolveInstalledManifestRegistryIndexFingerprint(
    params.pluginGeneration.pluginMetadataSnapshot.index,
  );
  const inventory = params.inventoryOwner.catalogInventory;
  // Full acquisition also discovers providers outside eligibleProviders; only a full refresh
  // reacquires them, so every provider whose own identity is unchanged keeps its rows.
  const providerSources = new Map(
    [...new Set([...eligibleProviders, ...(inventory?.providers.keys() ?? [])])].map((provider) => [
      provider,
      preparedProviderCatalogSource(facts, params.pluginGeneration, provider, normalizeProvider),
    ]),
  );
  const previousAuth = inventory && getPreparedModelFullCatalogAuth(inventory.catalog);
  // A provider whose own config and credentials are unchanged keeps its rows visible; a changed
  // or removed provider loses them at once. Rows from another plugin generation stay
  // provisional until this generation rediscovers them.
  const keptProviders = new Set(
    [...providerSources.keys()].filter(
      (provider) =>
        inventory?.providers.get(provider)?.source === providerSources.get(provider) &&
        hasSamePreparedModelCatalogAuth(
          previousAuth,
          facts,
          (id) => normalizeProvider(id) === provider,
        ),
    ),
  );
  const provenProviders =
    inventory?.pluginFingerprint === pluginFingerprint ? keptProviders : new Set<string>();
  const retainedInventory: PreparedModelCatalogInventory | undefined =
    inventory && keptProviders.size
      ? {
          ...selectPreparedModelCatalogInventory(inventory, (provider) =>
            keptProviders.has(normalizeProvider(provider)),
          ),
          nativeSource,
        }
      : undefined;
  if (retainedInventory) {
    retainedInventory.providers = new Map(
      [...retainedInventory.providers].map(([provider, providerFacts]) => [
        provider,
        provenProviders.has(provider) ? providerFacts : { ...providerFacts, provisional: true },
      ]),
    );
    // A harness may list models from any agent or plugin setting, so native rows survive only an
    // unchanged native source. Native presence markers and empty credentials do not identify
    // an account.
    const identifiedNativeProviders = new Set(
      inventory?.nativeSource === nativeSource
        ? Object.entries(facts.credentials).flatMap(([provider, credential]) =>
            credential.type === "api_key" && credential.nativeAuth
              ? []
              : [normalizeProvider(provider)],
          )
        : [],
    );
    const includesNativeProvider = (provider: string) =>
      identifiedNativeProviders.has(normalizeProvider(provider));
    const retain = (entry: ModelCatalogSnapshot["entries"][number]) =>
      !entry.nativeRuntime || includesNativeProvider(entry.provider);
    retainedInventory.catalog.entries = retainedInventory.catalog.entries.filter(retain);
    retainedInventory.catalog.routeVariants =
      retainedInventory.catalog.routeVariants.filter(retain);
    retainedInventory.catalog.nativeProviderOutcomes = filterNativeModelCatalogScopes(
      retainedInventory.catalog.nativeProviderOutcomes,
      includesNativeProvider,
    );
    // Untagged harness rows describe the current host projection, not identified native
    // account inventory. Reacquire them with this generation before enriching API routes.
    retainedInventory.catalog.nativeHostRows = undefined;
  }
  // Changed providers and provisional rows are reacquired by this generation.
  const unretainedProviders = [...(inventory?.providers.keys() ?? [])].filter(
    (provider) => !provenProviders.has(provider),
  );
  // Only prepared facts escape; callbacks here would retain the previous inventory.
  return {
    retainedInventory,
    providerSources,
    unretainedProviders,
    inventoryKey,
    nativeSource,
    pluginFingerprint,
  };
}

/** Providers whose source or credentials changed, including dropped and provisional rows. */
export function listChangedPreparedCatalogProviders(
  facts: PreparedModelRuntimeAgentFacts,
  normalizeProvider: (provider: string) => string,
  providerSources: ReadonlyMap<string, string>,
  unretainedProviders: readonly string[],
  inventory: PreparedModelCatalogInventory | undefined,
  candidates: readonly string[] = [
    ...Object.keys(facts.credentials),
    ...unretainedProviders.filter(
      (provider) =>
        !inventory?.providers.has(provider) || inventory.providers.get(provider)?.provisional,
    ),
  ],
): string[] {
  return [...new Set(candidates.map(normalizeProvider))].filter(
    (provider) =>
      inventory?.providers.get(provider)?.provisional === true ||
      inventory?.providers.get(provider)?.source !== providerSources.get(provider) ||
      inventory?.providers.get(provider)?.credentials !==
        preparedProviderCatalogCredentials(facts, provider, normalizeProvider),
  );
}
