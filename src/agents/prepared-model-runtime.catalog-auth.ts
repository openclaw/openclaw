import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog-outcome.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { listManifestSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import {
  resolveAgentCredentialMapFromStore,
  resolveUsableAgentCredentialModes,
} from "./agent-auth-credentials.js";
import { prepareAmbientAgentCredentialsForDiscovery } from "./agent-auth-discovery.js";
import { withPreparedAuthStorePathForDisplay } from "./auth-profiles/paths.js";
import { mergeAuthProfileStores } from "./auth-profiles/persisted.js";
import { removeRuntimeExternalProfileReferences } from "./auth-profiles/runtime-external-profile-references.js";
import type { AuthProfileCredential, RuntimeAuthProfileStore } from "./auth-profiles/types.js";
import { resolveProviderConfigSecretInput } from "./model-auth-provider-config.js";
import { prepareModelCatalogAuthLabels } from "./model-catalog-auth-labels.js";
import { normalizeCatalogRouteBaseUrl } from "./model-compat-catalog.js";
import type {
  ModelServiceTierObservation,
  PreparedAccountCatalogAccess,
  PreparedModelCatalogAuth,
  PreparedModelRuntimeAuth,
  PreparedModelRuntimeAuthScope,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { preparedSyntheticAuthProviderScope } from "./prepared-model-runtime.synthetic-auth.js";

// Startup captures each CLI login once; ordinary reads recheck it after this window.
const NATIVE_LOGIN_RECHECK_MS = 60_000;

const SERVICE_TIER_OBSERVATION_TTL_MS = 5 * 60_000;
function readDirectBinding(config: OpenClawConfig, provider: string) {
  const { providerConfig, ref } = resolveProviderConfigSecretInput(config, provider);
  return { apiKey: ref ?? providerConfig?.apiKey, auth: providerConfig?.auth };
}
type AccountCatalogCredential =
  | { source: "profile"; credential: AuthProfileCredential }
  | { source: "direct"; provider: string; credential: ReturnType<typeof readDirectBinding> };
type AccountCatalogObservation = AccountCatalogCredential & {
  pending?: { refresh: boolean; promise: Promise<AccountCatalogObservation> };
  outcomes?: readonly ProviderCatalogOutcome[];
  serviceTierObservations?: readonly (ModelServiceTierObservation & { expiresAt: number })[];
};

function matchesServiceTierRoute(
  observation: ModelServiceTierObservation,
  route: Pick<ModelServiceTierObservation, "modelId" | "runtimeId" | "api" | "baseUrl">,
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
  onChanged?: () => void,
): PreparedAccountCatalogAccess {
  const ownerIsCurrent = () => !retirementSignal?.aborted && isCurrent();
  const accounts = new Map<string, AccountCatalogObservation>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (!onChanged || !ownerIsCurrent()) {
      return;
    }
    let nextExpiry = Infinity;
    for (const account of accounts.values()) {
      for (const observation of account.serviceTierObservations ?? []) {
        nextExpiry = Math.min(nextExpiry, observation.expiresAt);
      }
    }
    if (nextExpiry === Infinity) {
      return;
    }
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        if (!ownerIsCurrent()) {
          return;
        }
        const now = Date.now();
        let changed = false;
        for (const account of accounts.values()) {
          const previous = account.serviceTierObservations;
          account.serviceTierObservations = previous?.filter(({ expiresAt }) => expiresAt > now);
          changed ||= account.serviceTierObservations?.length !== previous?.length;
        }
        scheduleExpiry();
        if (changed) {
          onChanged();
        }
      },
      Math.max(0, nextExpiry - Date.now()),
    );
    expiryTimer.unref();
  };
  const deleteAccount = (identityKey: string) => {
    const observed = accounts.get(identityKey)?.serviceTierObservations?.length;
    if (accounts.delete(identityKey)) {
      scheduleExpiry();
      if (observed) {
        onChanged?.();
      }
    }
  };
  const readAccount = (identityKey: string, credential: AccountCatalogCredential["credential"]) => {
    const account = accounts.get(identityKey);
    if (account && !isDeepStrictEqual(account.credential, credential)) {
      deleteAccount(identityKey);
      return undefined;
    }
    return account;
  };
  const createAccount = (identityKey: string, credential: AccountCatalogCredential) => {
    const account: AccountCatalogObservation = structuredClone(credential);
    accounts.set(identityKey, account);
    for (const key of accounts.keys()) {
      if (accounts.size <= 64) {
        break;
      }
      deleteAccount(key);
    }
    return account;
  };
  retirementSignal?.addEventListener(
    "abort",
    () => {
      accounts.clear();
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    },
    { once: true },
  );
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
          deleteAccount(identityKey);
        }
      }
    },
    readServiceTierObservation(params) {
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
      const observation = account?.serviceTierObservations?.find((candidate) =>
        matchesServiceTierRoute(candidate, route),
      );
      return observation && observation.expiresAt > Date.now()
        ? { requestedTier: observation.requestedTier, responseTier: observation.responseTier }
        : undefined;
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
        const now = Date.now();
        const previous = captured.serviceTierObservations?.find(
          (candidate) => candidate.expiresAt > now && matchesServiceTierRoute(candidate, route),
        );
        let changed = false;
        captured.serviceTierObservations = (captured.serviceTierObservations ?? []).filter(
          (candidate) => {
            if (candidate.expiresAt <= now) {
              changed = true;
              return false;
            }
            return !matchesServiceTierRoute(candidate, route);
          },
        );
        const matched = observation.requestedTier === observation.responseTier;
        if (!matched) {
          captured.serviceTierObservations = [
            ...captured.serviceTierObservations.slice(-127),
            { ...route, expiresAt: now + SERVICE_TIER_OBSERVATION_TTL_MS },
          ];
        }
        changed ||= matched
          ? Boolean(previous)
          : previous?.requestedTier !== observation.requestedTier ||
            previous?.responseTier !== observation.responseTier;
        scheduleExpiry();
        if (changed) {
          onChanged?.();
        }
        return changed;
      };
    },
    async acquire(params) {
      if (!ownerIsCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Selected account catalog changed",
        );
      }
      const identityKey = `profile:${params.profileId}`;
      let observation = readAccount(identityKey, params.credential);
      if (!observation) {
        if (!params.allowDiscovery) {
          return { outcomes: [], isCurrent: () => ownerIsCurrent() && !accounts.has(identityKey) };
        }
        observation = createAccount(identityKey, {
          source: "profile",
          credential: params.credential,
        });
      }
      const current = (account: AccountCatalogObservation) =>
        ownerIsCurrent() && accounts.get(identityKey) === account;
      const assertCurrent = (account: AccountCatalogObservation) => {
        if (!current(account)) {
          throw new PreparedModelRuntimePublicationSupersededError(
            "Selected account catalog changed",
          );
        }
      };
      const needsDiscovery = params.allowDiscovery && (params.refresh || !observation.outcomes);
      if (needsDiscovery && !observation.pending) {
        const captured = observation;
        const pending: NonNullable<AccountCatalogObservation["pending"]> = {
          refresh: false,
          promise: Promise.resolve()
            .then(async () => {
              assertCurrent(captured);
              const outcomes = await params.load();
              assertCurrent(captured);
              captured.pending = undefined;
              // Refresh retires old projections and response hints only after discovery succeeds.
              const published = pending.refresh
                ? createAccount(identityKey, { source: "profile", credential: params.credential })
                : captured;
              published.outcomes = outcomes;
              if (pending.refresh && captured.serviceTierObservations?.length) {
                scheduleExpiry();
                onChanged?.();
              }
              return published;
            })
            .finally(() => {
              if (captured.pending === pending) {
                captured.pending = undefined;
              }
            }),
        };
        captured.pending = pending;
      }
      // Warm reads consume the last publication; only cold discovery and explicit refresh wait.
      if (needsDiscovery) {
        observation.pending!.refresh ||= params.refresh === true;
        observation = await observation.pending!.promise;
      }
      const published = observation;
      assertCurrent(published);
      const outcomes = published.outcomes;
      return {
        outcomes: outcomes ?? [],
        isCurrent: () => current(published) && published.outcomes === outcomes,
      };
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

type PreparedModelCatalogAuthOwner = {
  pluginGeneration: PreparedModelRuntimeCatalogAccessParams["pluginGeneration"];
  accountCatalog: PreparedAccountCatalogAccess;
  normalizeProvider: (provider: string) => string;
  assertCurrent: () => void;
  readAuth: () => PreparedModelCatalogAuth;
  refreshAuth: (
    scope: PreparedModelRuntimeAuthScope,
  ) => Promise<Parameters<typeof replacePreparedModelCatalogAuth>[1]>;
};

async function refreshScopedModelCatalogAuth(
  owner: PreparedModelCatalogAuthOwner,
  { providerIds, profileIds }: PreparedModelRuntimeAuthScope,
): Promise<PreparedModelCatalogAuth> {
  owner.assertCurrent();
  await using _ = {
    [Symbol.asyncDispose]: retainPreparedPluginGeneration(owner.pluginGeneration),
  };
  const refreshed = await owner.refreshAuth({
    providerIds,
    ...(profileIds?.length ? { profileIds } : {}),
  });
  owner.assertCurrent();
  const scope = preparedSyntheticAuthProviderScope(providerIds.map(owner.normalizeProvider));
  const includesProvider = (provider: string) => scope.has(owner.normalizeProvider(provider));
  owner.accountCatalog.reconcileAuth(refreshed.authStore, includesProvider, profileIds);
  return replacePreparedModelCatalogAuth(owner.readAuth(), refreshed, includesProvider);
}

/** Refreshes scoped auth and merges it over the owner's current catalog auth. */
export async function loadScopedModelCatalogAuth(
  owner: PreparedModelCatalogAuthOwner,
  scope: PreparedModelRuntimeAuthScope,
): Promise<PreparedModelRuntimeAuth> {
  const { authStore, authModes } = await refreshScopedModelCatalogAuth(owner, scope);
  return { authStore, authModes: Object.freeze(authModes) };
}

/** Rechecks CLI backend logins on demand and publishes only a changed result. */
export function createNativeLoginRecheck(
  owner: PreparedModelCatalogAuthOwner,
  params: {
    agentFacts: Pick<PreparedModelRuntimeCatalogAccessParams["agentFacts"], "input" | "env">;
    retirementSignal: AbortSignal;
  },
  eligibleProviders: readonly string[],
  publish: (auth: PreparedModelCatalogAuth) => void,
): () => void {
  const { owners, index } = owner.pluginGeneration.pluginMetadataSnapshot;
  const refs = new Set(listManifestSyntheticAuthProviderRefs(index).map(owner.normalizeProvider));
  const providerIds = eligibleProviders.filter(
    (provider) => owners.cliBackends.has(provider) && refs.has(provider),
  );
  let checkedAt = Date.now();
  let pending = false;
  const recheck = async () => {
    owner.assertCurrent();
    await using _ = {
      [Symbol.asyncDispose]: retainPreparedPluginGeneration(owner.pluginGeneration),
    };
    const { input, env } = params.agentFacts;
    const signal = AbortSignal.any([params.retirementSignal, AbortSignal.timeout(180_000)]);
    await withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: owner.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: owner.pluginGeneration.pluginRegistry,
      },
      async () => {
        const credentials = await prepareAmbientAgentCredentialsForDiscovery({
          config: input.config,
          env,
          workspaceDir: input.workspaceDir,
          authoritativeSyntheticAuthProviderRefs: providerIds,
          syntheticAuthProviderRefs: providerIds,
          preparationOwner: {},
          signal,
        });
        signal.throwIfAborted();
        owner.assertCurrent();
        const current = owner.readAuth();
        // Native availability changes independently of stored profiles; reuse their current owner.
        Object.assign(
          credentials,
          resolveAgentCredentialMapFromStore(current.authStore, { config: input.config }),
        );
        const auth = replacePreparedModelCatalogAuth(
          current,
          {
            authStore: current.authStore,
            credentials,
            authModes: resolveUsableAgentCredentialModes(credentials),
          },
          (provider) => providerIds.includes(owner.normalizeProvider(provider)),
        );
        owner.assertCurrent();
        if (!isDeepStrictEqual(current.authModes, auth.authModes)) {
          publish(auth);
        }
      },
    );
  };
  return () => {
    const now = Date.now();
    if (pending || !providerIds.length || now - checkedAt < NATIVE_LOGIN_RECHECK_MS) {
      return;
    }
    checkedAt = now;
    pending = true;
    void recheck()
      .catch(() => undefined)
      .finally(() => {
        pending = false;
      });
  };
}
