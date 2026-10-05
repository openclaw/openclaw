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
  options: {
    observeScopedRemovals?: boolean;
    /** Providers whose omitted auth was observed removed; defaults to every scoped provider. */
    observedRemovals?: (provider: string) => boolean;
  } = {},
): PreparedModelCatalogAuth {
  const take = ([provider]: readonly [string, unknown]) => includesProvider(provider);
  const rediscoveredProviders = new Set(
    Object.values(next.authStore.profiles).map((profile) => profile.provider),
  );
  // A partial refresh is authoritative only for the providers it actually
  // re-discovered; a scoped-but-absent entry keeps the prior value so a
  // passive read cannot blank out still-valid auth (e.g. cli backends).
  // A refresh that observes a scoped provider's credential source turns its
  // omission into a removal: prior entries must not survive it, or a
  // logged-out provider stays published as available.
  const observedRemoval = (provider: string) =>
    options.observedRemovals
      ? options.observedRemovals(provider)
      : options.observeScopedRemovals === true;
  const keepsPriorEntry = (provider: string) =>
    includesProvider(provider)
      ? !observedRemoval(provider) && !rediscoveredProviders.has(provider)
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
                  (!observedRemoval(provider) || rediscoveredProviders.has(provider))),
            )
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
