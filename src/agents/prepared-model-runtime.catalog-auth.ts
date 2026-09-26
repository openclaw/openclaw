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
  const keep = ([provider]: readonly [string, unknown]) => !includesProvider(provider);
  const take = ([provider]: readonly [string, unknown]) => includesProvider(provider);
  const replace = <T>(
    before: Readonly<Record<string, T>> | undefined,
    after: Readonly<Record<string, T>> | undefined,
  ) =>
    Object.fromEntries([
      ...Object.entries(before ?? {}).filter(keep),
      ...Object.entries(after ?? {}).filter(take),
    ]);
  const selectStore = (
    store: RuntimeAuthProfileStore,
    selected: boolean,
  ): RuntimeAuthProfileStore => {
    const scoped = removeRuntimeExternalProfileReferences({
      store,
      profileIds: new Set(
        Object.entries(store.profiles)
          .filter(([, profile]) => includesProvider(profile.provider) !== selected)
          .map(([id]) => id),
      ),
    });
    return {
      ...scoped,
      order:
        scoped.order &&
        Object.fromEntries(Object.entries(scoped.order).filter(selected ? take : keep)),
      lastGood:
        scoped.lastGood &&
        Object.fromEntries(Object.entries(scoped.lastGood).filter(selected ? take : keep)),
      runtimeLocalOrderProviderIds: store.runtimeLocalOrderProviderIds?.filter(
        (provider) => includesProvider(provider) === selected,
      ),
    };
  };
  const retained = selectStore(previous.authStore, false);
  const refreshed = selectStore(next.authStore, true);
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
            .filter(keep)
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
