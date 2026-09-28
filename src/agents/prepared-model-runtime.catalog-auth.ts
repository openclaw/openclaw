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
  options: { observeScopedRemovals?: boolean } = {},
): PreparedModelCatalogAuth {
  const take = ([provider]: readonly [string, unknown]) => includesProvider(provider);
  const rediscoveredProviders = new Set(
    Object.values(next.authStore.profiles).map((profile) => profile.provider),
  );
  // A partial refresh is authoritative only for the providers it actually
  // re-discovered; a scoped-but-absent entry keeps the prior value so a
  // passive read cannot blank out still-valid auth (e.g. cli backends).
  // A refresh that observes each scoped provider's credential source (an
  // explicit auth refresh, or a scoped catalog refresh whose worker re-reads
  // the source) turns a scoped omission into a removal: prior entries must
  // not survive it, or a logged-out provider stays published as available.
  const keepsPriorEntry = (provider: string) =>
    includesProvider(provider)
      ? options.observeScopedRemovals !== true && !rediscoveredProviders.has(provider)
      : true;
  const replace = <T>(
    before: Readonly<Record<string, T>> | undefined,
    after: Readonly<Record<string, T>> | undefined,
  ) => {
    const merged = new Map(
      Object.entries(before ?? {}).filter(([provider]) => keepsPriorEntry(provider)),
    );
    for (const [provider, value] of Object.entries(after ?? {})) {
      if (includesProvider(provider)) {
        merged.set(provider, value);
      }
    }
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
  const retained = selectStore(previous.authStore, keepsPriorEntry);
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
            .filter(
              ([provider]) =>
                !includesProvider(provider) ||
                // An observed next label replaces the prior one below. When the
                // refresh omits a scoped label, only a provider whose auth was
                // observed removed loses the prior label; a rediscovered
                // provider keeps it so an unobserved label omission cannot
                // churn the publication.
                (!next.providerAuthLabels?.has(provider) &&
                  (options.observeScopedRemovals !== true || rediscoveredProviders.has(provider))),
            )
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
