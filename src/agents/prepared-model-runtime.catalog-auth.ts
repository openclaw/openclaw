import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { resolveUsableAgentCredentialModes } from "./agent-auth-credentials.js";
import { withPreparedAuthStorePathForDisplay } from "./auth-profiles/paths.js";
import { mergeAuthProfileStores } from "./auth-profiles/persisted.js";
import { removeRuntimeExternalProfileReferences } from "./auth-profiles/runtime-external-profile-references.js";
import type { AuthProfileCredential, RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import { resolveProviderConfigSecretInput } from "./model-auth-provider-config.js";
import { prepareModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import { normalizeCatalogRouteBaseUrl } from "./model-compat-catalog.js";
import type {
  PreparedAccountCatalogAccess,
  PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";

type ModelServiceTierObservation = NonNullable<ProviderCatalogOutcome["modelServiceTiers"]>[number];
function readDirectBinding(config: OpenClawConfig, provider: string) {
  const { providerConfig, ref } = resolveProviderConfigSecretInput(config, provider);
  return { apiKey: ref ?? providerConfig?.apiKey, auth: providerConfig?.auth };
}
type AccountCatalogCredential =
  | { source: "profile"; credential: AuthProfileCredential }
  | { source: "direct"; provider: string; credential: ReturnType<typeof readDirectBinding> };
type AccountCatalogObservation = AccountCatalogCredential & {
  result?: Promise<readonly ProviderCatalogOutcome[]>;
  outcomes?: readonly ProviderCatalogOutcome[];
  modelServiceTiers?: readonly ModelServiceTierObservation[];
};

function matchesServiceTierRoute(
  observation: ModelServiceTierObservation,
  route: Omit<ModelServiceTierObservation, "serviceTiers">,
): boolean {
  return (
    observation.modelId === route.modelId &&
    observation.runtimeId === route.runtimeId &&
    observation.api === route.api &&
    observation.baseUrl === route.baseUrl
  );
}

/** The existing catalog generation owns selected-account initialization and explicit refresh. */
export function createPreparedAccountCatalogAccess(
  isCurrent: () => boolean,
  retirementSignal?: AbortSignal,
  config: OpenClawConfig = {},
): PreparedAccountCatalogAccess {
  const ownerIsCurrent = () => !retirementSignal?.aborted && isCurrent();
  const accounts = new Map<string, AccountCatalogObservation>();
  const readAccount = (identityKey: string, credential: AccountCatalogCredential["credential"]) => {
    const account = accounts.get(identityKey);
    if (account && !isDeepStrictEqual(account.credential, credential)) {
      accounts.delete(identityKey);
      return undefined;
    }
    return account;
  };
  const createAccount = (identityKey: string, credential: AccountCatalogCredential) => {
    const account: AccountCatalogObservation = structuredClone(credential);
    accounts.set(identityKey, account);
    pruneMapToMaxSize(accounts, 64);
    return account;
  };
  retirementSignal?.addEventListener("abort", () => accounts.clear(), { once: true });
  return {
    reconcileAuth(authStore, includesProvider, profileIds) {
      if (!ownerIsCurrent()) {
        return;
      }
      for (const [identityKey, account] of accounts) {
        if (account.source === "direct") {
          if (includesProvider(account.provider)) {
            readAccount(identityKey, readDirectBinding(config, account.provider));
          }
          continue;
        }
        const profileId = identityKey.slice("profile:".length);
        const credential = authStore.profiles[profileId];
        // Shared auth refresh never loads unselected personal accounts.
        if (!credential && isUserModelAuthProfileId(profileId)) {
          continue;
        }
        if (
          (includesProvider(account.credential.provider) || profileIds?.includes(profileId)) &&
          !isDeepStrictEqual(account.credential, credential)
        ) {
          accounts.delete(identityKey);
        }
      }
    },
    readServiceTiers(params) {
      if (!ownerIsCurrent()) {
        return undefined;
      }
      const route = {
        ...params,
        baseUrl: normalizeCatalogRouteBaseUrl(params.baseUrl) ?? params.baseUrl,
      };
      let account = accounts.get(params.identityKey);
      if (account?.source === "direct") {
        account = readAccount(params.identityKey, readDirectBinding(config, account.provider));
      }
      const observation = account?.modelServiceTiers?.find((candidate) =>
        matchesServiceTierRoute(candidate, route),
      );
      return observation && [...observation.serviceTiers];
    },
    prepareServiceTierObserver(params) {
      const selected = params.selectedCredential;
      if (!ownerIsCurrent() || selected.source === "harness") {
        return () => false;
      }
      let captured: AccountCatalogObservation;
      if (selected.source === "profile") {
        if (!params.credential) {
          return () => false;
        }
        captured =
          readAccount(selected.identityKey, params.credential) ??
          createAccount(selected.identityKey, { source: "profile", credential: params.credential });
      } else {
        const credential = readDirectBinding(config, selected.provider);
        captured =
          readAccount(selected.identityKey, credential) ??
          createAccount(selected.identityKey, {
            source: "direct",
            provider: selected.provider,
            credential,
          });
      }
      return (observation) => {
        if (
          !ownerIsCurrent() ||
          accounts.get(selected.identityKey) !== captured ||
          (captured.source === "direct" &&
            readAccount(selected.identityKey, readDirectBinding(config, captured.provider)) !==
              captured)
        ) {
          return false;
        }
        const route = {
          ...observation,
          baseUrl: normalizeCatalogRouteBaseUrl(observation.baseUrl) ?? observation.baseUrl,
        };
        const previous = captured.modelServiceTiers?.find((candidate) =>
          matchesServiceTierRoute(candidate, route),
        );
        if (isDeepStrictEqual(previous?.serviceTiers, observation.serviceTiers)) {
          return false;
        }
        captured.modelServiceTiers = [
          ...(captured.modelServiceTiers ?? [])
            .filter((candidate) => !matchesServiceTierRoute(candidate, route))
            .slice(-127),
          { ...route, serviceTiers: [...observation.serviceTiers] },
        ];
        return true;
      };
    },
    async acquire(params) {
      if (!ownerIsCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Selected account catalog changed",
        );
      }
      if (params.allowDiscovery && params.refresh) {
        accounts.delete(`profile:${params.profileId}`);
      }
      const identityKey = `profile:${params.profileId}`;
      let observation = readAccount(identityKey, params.credential);
      if (!observation) {
        if (!params.allowDiscovery) {
          return { outcomes: [], isCurrent: ownerIsCurrent };
        }
        observation = createAccount(identityKey, {
          source: "profile",
          credential: params.credential,
        });
      }
      // A response observation does not mean this account's catalog was discovered.
      if (params.allowDiscovery && !observation.result) {
        observation.result = Promise.resolve().then(params.load);
      }
      // Startup/read-only projections never join an in-flight remote acquisition.
      const result = observation.result;
      if (!result || (!params.allowDiscovery && !observation.outcomes)) {
        return { outcomes: [], isCurrent: ownerIsCurrent };
      }
      const captured = observation;
      const current = () =>
        ownerIsCurrent() && accounts.get(`profile:${params.profileId}`) === captured;
      let outcomes: readonly ProviderCatalogOutcome[];
      try {
        outcomes = captured.outcomes ?? (await result);
      } catch (error) {
        // A revoked request cannot poison a later authorized selection of this account.
        if (current()) {
          if (captured.modelServiceTiers?.length) {
            // Catalog failure cannot erase a tier actually observed on the API route.
            captured.result = undefined;
          } else {
            accounts.delete(`profile:${params.profileId}`);
          }
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
