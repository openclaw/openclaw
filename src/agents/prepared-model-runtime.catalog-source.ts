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
import { fingerprintPreparedRuntimeFacts } from "./prepared-model-runtime.facts.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

function preparedProviderCatalogSource(
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

function prepareRetainedProviderCatalogSeed(
  params: PreparedModelRuntimeCatalogAccessParams,
  normalizeProvider: (provider: string) => string,
  eligibleProviders: readonly string[],
  pluginFingerprint: string,
  nativeSource: string,
  providerSource: (provider: string) => string,
) {
  const facts = params.agentFacts;
  const inventory = params.inventoryOwner.catalogInventory;
  // Full acquisition also discovers providers outside eligibleProviders; only a full refresh
  // reacquires them, so every provider whose own identity is unchanged keeps its rows.
  const providerSources = new Map(
    [...new Set([...eligibleProviders, ...(inventory?.providers.keys() ?? [])])].map((provider) => [
      provider,
      providerSource(provider),
    ]),
  );
  const previousAuth = inventory && getPreparedModelFullCatalogAuth(inventory.catalog);
  const retainedProviders = new Set(
    [...providerSources.keys()].filter(
      (provider) =>
        inventory?.pluginFingerprint === pluginFingerprint &&
        inventory.providers.get(provider)?.source === providerSources.get(provider) &&
        hasSamePreparedModelCatalogAuth(
          previousAuth,
          facts,
          (id) => normalizeProvider(id) === provider,
        ),
    ),
  );
  const retainedInventory: PreparedModelCatalogInventory | undefined =
    inventory && retainedProviders.size
      ? {
          ...selectPreparedModelCatalogInventory(inventory, (provider) =>
            retainedProviders.has(normalizeProvider(provider)),
          ),
          nativeSource,
        }
      : undefined;
  if (retainedInventory) {
    // Native presence markers and empty credentials do not identify an account.
    const identifiedNativeProviders = new Set(
      inventory?.nativeSource === nativeSource
        ? Object.entries(facts.credentials).flatMap(([provider, credential]) =>
            credential.type === "api_key" && credential.nativeAuth
              ? []
              : [normalizeProvider(provider)],
          )
        : [],
    );
    const retain = (entry: ModelCatalogSnapshot["entries"][number]) =>
      !entry.nativeRuntime || identifiedNativeProviders.has(normalizeProvider(entry.provider));
    retainedInventory.catalog.entries = retainedInventory.catalog.entries.filter(retain);
    retainedInventory.catalog.routeVariants =
      retainedInventory.catalog.routeVariants.filter(retain);
    const includesNativeProvider = (provider: string) =>
      identifiedNativeProviders.has(normalizeProvider(provider));
    retainedInventory.catalog.nativeProviderOutcomes = filterNativeModelCatalogScopes(
      retainedInventory.catalog.nativeProviderOutcomes,
      includesNativeProvider,
    );
    // Untagged harness rows describe the current host projection, not identified native
    // account inventory. Reacquire them with this generation before enriching API routes.
    retainedInventory.catalog.nativeHostRows = undefined;
  }
  // A rebuild cannot always prove the account behind discovery-only credentials, such as a
  // native CLI sign-in. Those providers are reacquired instead of disappearing until a refresh.
  const unretainedProviders = [...(inventory?.providers.keys() ?? [])].filter(
    (provider) => !retainedProviders.has(provider),
  );
  return { providerSources, retainedInventory, unretainedProviders };
}

/** Reuse only catalog rows whose provider identity and credentials survived publication. */
export function prepareRetainedProviderCatalog(
  params: PreparedModelRuntimeCatalogAccessParams,
  normalizeProvider: (provider: string) => string,
  eligibleProviders: readonly string[],
  pluginFingerprint: string,
  nativeSource: string,
) {
  const facts = params.agentFacts;
  const providerSource = (provider: string) =>
    preparedProviderCatalogSource(
      params.agentFacts,
      params.pluginGeneration,
      provider,
      normalizeProvider,
    );
  const { providerSources, retainedInventory, unretainedProviders } =
    prepareRetainedProviderCatalogSeed(
      params,
      normalizeProvider,
      eligibleProviders,
      pluginFingerprint,
      nativeSource,
      providerSource,
    );
  /** Providers a changed-only pass reacquires: changed source or credentials, or dropped rows. */
  const listChangedProviders = (
    published: PreparedModelCatalogInventory | undefined,
    candidates: readonly string[] = [
      ...Object.keys(facts.credentials),
      ...unretainedProviders.filter((provider) => !published?.providers.has(provider)),
    ],
  ) =>
    [...new Set(candidates.map(normalizeProvider))].filter(
      (provider) =>
        published?.providers.get(provider)?.source !== providerSources.get(provider) ||
        published?.providers.get(provider)?.credentials !==
          preparedProviderCatalogCredentials(facts, provider, normalizeProvider),
    );
  return { providerSource, retainedInventory, listChangedProviders };
}
