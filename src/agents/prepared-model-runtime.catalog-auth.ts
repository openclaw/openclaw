import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { mergeAuthProfileStores } from "./auth-profiles/persisted.js";
import { removeRuntimeExternalProfileReferences } from "./auth-profiles/runtime-external-profile-references.js";
import type { RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import { prepareModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import type { PreparedModelCatalogAuth } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";

export function replacePreparedModelCatalogAuth(
  previous: PreparedModelCatalogAuth,
  next: Partial<PreparedModelCatalogAuth> &
    Pick<PreparedModelCatalogAuth, "authStore" | "authModes">,
  includesProvider: (provider: string) => boolean,
): PreparedModelCatalogAuth {
  const take = ([provider]: readonly [string, unknown]) => includesProvider(provider);
  const replace = <T>(
    before: Readonly<Record<string, T>> | undefined,
    after: Readonly<Record<string, T>> | undefined,
  ) => {
    const merged = new Map(Object.entries(before ?? {}));
    for (const [provider, value] of Object.entries(after ?? {})) {
      if (includesProvider(provider)) {
        merged.set(provider, value);
      }
    }
    // A partial refresh is authoritative only for the providers it actually
    // re-discovered; a scoped-but-absent entry keeps the prior value so a
    // passive read cannot blank out still-valid auth (e.g. cli backends).
    return Object.fromEntries(merged);
  };
  const selectStore = (
    store: RuntimeAuthProfileStore,
    select: (provider: string) => boolean,
  ): RuntimeAuthProfileStore => {
    const scoped = removeRuntimeExternalProfileReferences({
      store,
      profileIds: new Set(
        Object.entries(store.profiles)
          .filter(([, profile]) => !select(profile.provider))
          .map(([id]) => id),
      ),
    });
    return {
      ...scoped,
      order:
        scoped.order &&
        Object.fromEntries(Object.entries(scoped.order).filter(([provider]) => select(provider))),
      lastGood:
        scoped.lastGood &&
        Object.fromEntries(
          Object.entries(scoped.lastGood).filter(([provider]) => select(provider)),
        ),
      runtimeLocalOrderProviderIds: store.runtimeLocalOrderProviderIds?.filter(select),
    };
  };
  const rediscoveredProviders = new Set(
    Object.values(next.authStore.profiles).map((profile) => profile.provider),
  );
  const retained = selectStore(previous.authStore, (provider) =>
    includesProvider(provider) ? !rediscoveredProviders.has(provider) : true,
  );
  const refreshed = selectStore(next.authStore, includesProvider);
  // Both partitions belong to this agent; merging must retain each local-origin list.
  for (const key of ["runtimeLocalProfileIds", "runtimeLocalOrderProviderIds"] as const) {
    if (retained[key] || refreshed[key]) {
      refreshed[key] = [...new Set([...(retained[key] ?? []), ...(refreshed[key] ?? [])])];
    }
  }
  return {
    // Durable rows outside this request can predate their last CLI overlay. Preserve
    // each untouched provider's catalog/auth pair, including local-origin metadata.
    authStore: mergeAuthProfileStores(retained, refreshed, {
      preserveBaseRuntimeExternalProfiles: true,
    }),
    credentials: replace(previous.credentials, next.credentials),
    authModes: replace(previous.authModes, next.authModes),
    providerAuthLabels: next.providerAuthLabels
      ? new Map(
          [...previous.providerAuthLabels]
            .filter(([provider]) => !next.providerAuthLabels?.has(provider))
            .concat([...next.providerAuthLabels].filter(take)),
        )
      : previous.providerAuthLabels,
  };
}

export function prepareInitialModelCatalogAuth(
  {
    agentFacts,
    catalogFacts,
    pluginGeneration,
  }: Pick<
    PreparedModelRuntimeCatalogAccessParams,
    "agentFacts" | "catalogFacts" | "pluginGeneration"
  >,
  eligibleProviders: readonly string[],
): PreparedModelCatalogAuth {
  return {
    authStore: agentFacts.authStore,
    credentials: agentFacts.credentials,
    authModes: resolveUsableAgentCredentialModes(agentFacts.credentials),
    providerAuthLabels: withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: pluginGeneration.pluginRegistry,
      },
      () =>
        prepareModelCatalogAuthLabels({
          ...agentFacts.input,
          env: agentFacts.env,
          store: agentFacts.authStore,
          providers: [
            ...eligibleProviders,
            ...catalogFacts.modelCatalog.entries.map((entry) => entry.provider),
            ...Object.values(agentFacts.authStore.profiles).map((profile) => profile.provider),
          ],
        }),
    ),
  };
}
