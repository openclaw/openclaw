import { isDeepStrictEqual } from "node:util";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { withPreparedAuthStorePathForDisplay } from "./auth-profiles/paths.js";
import { mergeAuthProfileStores } from "./auth-profiles/persisted.js";
import { removeRuntimeExternalProfileReferences } from "./auth-profiles/runtime-external-profile-references.js";
import type { AuthProfileCredential, RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import { prepareModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import type {
  PreparedAccountCatalogAccess,
  PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";

/** The existing catalog generation owns selected-account initialization and explicit refresh. */
export function createPreparedAccountCatalogAccess(
  isCurrent: () => boolean,
  retirementSignal?: AbortSignal,
): PreparedAccountCatalogAccess {
  const ownerIsCurrent = () => !retirementSignal?.aborted && isCurrent();
  const accounts = new Map<
    string,
    {
      credential: AuthProfileCredential;
      result: Promise<readonly ProviderCatalogOutcome[]>;
      outcomes?: readonly ProviderCatalogOutcome[];
    }
  >();
  retirementSignal?.addEventListener("abort", () => accounts.clear(), { once: true });
  return {
    async acquire(params) {
      if (!ownerIsCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Selected account catalog changed",
        );
      }
      let observation = accounts.get(params.profileId);
      if (observation && !isDeepStrictEqual(observation.credential, params.credential)) {
        accounts.delete(params.profileId);
        observation = undefined;
      }
      if (!observation || (params.allowDiscovery && params.refresh)) {
        if (!params.allowDiscovery) {
          return { outcomes: [], isCurrent: ownerIsCurrent };
        }
        const result = Promise.resolve().then(params.load);
        observation = { credential: structuredClone(params.credential), result };
        accounts.set(params.profileId, observation);
        pruneMapToMaxSize(accounts, 64);
      }
      // Startup/read-only projections never join an in-flight remote acquisition.
      if (!params.allowDiscovery && !observation.outcomes) {
        return { outcomes: [], isCurrent: ownerIsCurrent };
      }
      const captured = observation;
      const current = () => ownerIsCurrent() && accounts.get(params.profileId) === captured;
      let outcomes: readonly ProviderCatalogOutcome[];
      try {
        outcomes = captured.outcomes ?? (await captured.result);
      } catch (error) {
        // A revoked request cannot poison a later authorized selection of this account.
        if (current()) {
          accounts.delete(params.profileId);
        }
        throw error;
      }
      if (!current()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Selected account catalog changed",
        );
      }
      captured.outcomes = outcomes;
      return { outcomes, isCurrent: current };
    },
  };
}

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

export async function prepareInitialModelCatalogAuth(
  {
    agentFacts,
    catalogFacts,
    pluginGeneration,
  }: Pick<
    PreparedModelRuntimeCatalogAccessParams,
    "agentFacts" | "catalogFacts" | "pluginGeneration"
  >,
  eligibleProviders: readonly string[],
  assertCurrent: () => void,
): Promise<PreparedModelCatalogAuth> {
  assertCurrent();
  const providers = [
    ...eligibleProviders,
    ...catalogFacts.modelCatalog.entries.map((entry) => entry.provider),
    ...Object.values(agentFacts.authStore.profiles).map((profile) => profile.provider),
  ];
  const providerAuthLabels =
    providers.length === 0
      ? new Map()
      : await withPreparedAuthStorePathForDisplay(
          agentFacts.input.agentDir,
          agentFacts.env,
          assertCurrent,
          (authStorePath) =>
            withPluginRuntimeGenerationScope(
              {
                metadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
                pluginRegistry: pluginGeneration.pluginRegistry,
              },
              () =>
                prepareModelCatalogAuthLabels({
                  ...agentFacts.input,
                  env: agentFacts.env,
                  authStorePath,
                  store: agentFacts.authStore,
                  providers,
                }),
            ),
        );
  assertCurrent();
  return {
    authStore: agentFacts.authStore,
    credentials: agentFacts.credentials,
    authModes: resolveUsableAgentCredentialModes(agentFacts.credentials),
    providerAuthLabels,
  };
}
