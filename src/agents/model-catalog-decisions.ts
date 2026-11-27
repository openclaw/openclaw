import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import { resolveProviderAuthScope } from "../plugins/provider-auth-scope.js";
import { createProviderModelRoutesResolver } from "../plugins/provider-model-routes.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getActiveSecretsRuntimeSnapshotRevisionState } from "../secrets/runtime-state.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../shared/current-read-authority.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import type { PersonalCatalogSelection } from "../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../state/user-profile-events.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveNativeModelPrimary,
} from "./agent-scope.js";
import { resolveExternalCliAuthScopeFromConfig } from "./auth-profiles/external-cli-scope.js";
import { materializePreparedPersonalAuthProfile } from "./auth-profiles/personal-profiles.js";
import { resolveAuthStoreReadOnlyValidUntil } from "./auth-profiles/read-only-availability.js";
import { listCliRuntimeModelBackendBindings } from "./cli-backends.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
} from "./model-auth-availability.js";
import { createAccountCatalogOutcomes } from "./model-catalog-account-outcomes.js";
import { createUnlistedClaudeCliWildcardCheck } from "./model-catalog-cli-wildcard.js";
import {
  createCatalogDecisionRuntimeResolver,
  createCatalogProjectionReader,
  type CatalogProjection,
} from "./model-catalog-decision-runtime.js";
import { createCatalogPluginAuth } from "./model-catalog-decisions.plugin-auth.js";
import type { ModelCatalogDecisionParams } from "./model-catalog-decisions.types.js";
import {
  createModelCatalogSnapshotView,
  listModelCatalogObservedRoutes,
  prepareModelCatalogView,
} from "./model-catalog-view.js";
import { loadManifestModelCatalog } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveDefaultModelForAgent } from "./model-selection-config.js";
import { dedupeModelCatalogEntries } from "./model-selection-shared.js";
import {
  createModelCatalogIdentityKeyResolver,
  openAIModelCatalogRoutePolicy,
} from "./openai-model-routes.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

export type { ModelCatalogDecisionParams } from "./model-catalog-decisions.types.js";
export {
  CATALOG_SCAN_YIELD_BUDGET_MS,
  resolveCatalogDecisionRuntime,
} from "./model-catalog-decision-runtime.js";

/** Prepare private records once under the caller's retained credential authority. */
export async function prepareModelCatalogDecisions(
  params: ModelCatalogDecisionParams,
  authority?: CurrentReadAuthority,
) {
  const selection: PersonalCatalogSelection | undefined =
    params.preferredProfileId && isUserModelAuthProfileId(params.preferredProfileId)
      ? { profileId: params.preferredProfileId }
      : !params.preferredProfileId && params.requesterProfileId
        ? { requesterProfileId: params.requesterProfileId }
        : undefined;
  if (!selection || params.preparedPersonalCatalog) {
    return withCurrentReadAuthority(authority, () => createModelCatalogDecisions(params));
  }
  const context = captureOpenClawStateReadWorkerContext();
  const linksAreCurrent =
    "requesterProfileId" in selection
      ? captureUserProfileModelAccountLinksAuthority(
          context.admission,
          selection.requesterProfileId,
        )
      : undefined;
  const isCurrent = () => {
    try {
      context.admission.assertCurrent();
      return linksAreCurrent?.() !== false;
    } catch {
      return false;
    }
  };
  const assertPreparedCurrent = () => {
    if (!isCurrent() || params.isCurrent?.() === false) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Personal model accounts changed while preparing the catalog",
      );
    }
  };
  const { readPersonalCatalogProfiles } = await import("./auth-profiles/sqlite-read.js");
  const profiles = await withCurrentReadAuthority(authority, () => {
    assertPreparedCurrent();
    if ("requesterProfileId" in selection && getActiveOpenClawStateDatabaseReadSnapshot()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Default account selection requires current link authority",
      );
    }
    return readPersonalCatalogProfiles(selection, context);
  });
  return withCurrentReadAuthority(authority, () => {
    assertPreparedCurrent();
    return createModelCatalogDecisions({
      ...params,
      preparedPersonalCatalog: { ...profiles, isCurrent },
    });
  });
}

/**
 * Builds requester/session auth views without changing shared catalog or credential snapshots.
 */
export function createModelCatalogDecisions(params: ModelCatalogDecisionParams) {
  // The Gateway owns one process-lifecycle plugin metadata snapshot. Carry it
  // through the whole projection so per-model normalization cannot rediscover it.
  const metadataSnapshot = params.metadataSnapshot;
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  // Execution inherits a configured account only for the effective primary.
  const configuredProfileId = splitTrailingAuthProfile(
    resolveNativeModelPrimary(params.cfg, params.agentId) ?? "",
  ).profile;
  const primary = resolveDefaultModelForAgent({ ...params, manifestPlugins: metadataSnapshot });
  const primaryEntry = primary && { provider: primary.provider, id: primary.model };
  // This decision view owns one plugin metadata generation. Resolve each provider's
  // identity policy once for that view instead of reloading it for every catalog row.
  const modelKeyOf = createModelCatalogIdentityKeyResolver();
  const primaryKey = primaryEntry && modelKeyOf(primaryEntry);
  const configuredPinForEntry = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    configuredProfileId !== undefined &&
    primaryKey !== undefined &&
    modelKeyOf(entry) === primaryKey
      ? configuredProfileId
      : undefined;
  // Runtime choices are read after preparation; CLI backends belong to the owner's registry.
  const cliRuntimeBindings = params.pluginRegistry
    ? withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
        listCliRuntimeModelBackendBindings(),
      )
    : listCliRuntimeModelBackendBindings();
  let authStore = params.preparedAuthStore;
  const preferredProfilesByProvider = new Map<string, string>();
  const personalProviders = new Set<string>();
  const personalCatalog = params.preparedPersonalCatalog;
  if (
    !personalCatalog &&
    ((params.preferredProfileId && isUserModelAuthProfileId(params.preferredProfileId)) ||
      (!params.preferredProfileId && params.requesterProfileId))
  ) {
    throw new Error("Personal model catalog records require asynchronous preparation");
  }
  // A persisted session pin wins over the current viewer's links. Only these
  // explicit selections enter this private projection, never its shared owner.
  if (params.preferredProfileId && isUserModelAuthProfileId(params.preferredProfileId)) {
    authStore = materializePreparedPersonalAuthProfile(
      authStore,
      params.preferredProfileId,
      personalCatalog?.profiles[params.preferredProfileId],
    );
    const provider = authStore.profiles[params.preferredProfileId]?.provider;
    if (provider) {
      personalProviders.add(normalizeProviderId(provider));
    }
  } else if (!params.preferredProfileId && params.requesterProfileId) {
    for (const link of personalCatalog?.links ?? []) {
      const selected = isUserModelAuthProfileId(link.authProfileId)
        ? materializePreparedPersonalAuthProfile(
            authStore,
            link.authProfileId,
            personalCatalog?.profiles[link.authProfileId],
          )
        : authStore;
      const provider =
        selected.profiles[link.authProfileId]?.provider ??
        params.cfg.auth?.profiles?.[link.authProfileId]?.provider;
      if (!provider || normalizeProviderId(provider) !== link.provider) {
        continue;
      }
      authStore = selected;
      preferredProfilesByProvider.set(link.provider, link.authProfileId);
      if (isUserModelAuthProfileId(link.authProfileId)) {
        personalProviders.add(link.provider);
      }
    }
  }
  const personalStaticEntries = personalProviders.size
    ? [
        ...(params.snapshot.staticEntries ?? []),
        ...loadManifestModelCatalog({ config: params.cfg, metadataSnapshot }),
      ].filter((entry) => personalProviders.has(normalizeProviderId(entry.provider)))
    : [];
  let snapshot = personalStaticEntries.length
    ? {
        ...params.snapshot,
        entries: dedupeModelCatalogEntries([...params.snapshot.entries, ...personalStaticEntries]),
        routeVariants: [
          ...(params.snapshot.routeVariants.length
            ? params.snapshot.routeVariants
            : params.snapshot.entries),
          ...personalStaticEntries,
        ],
      }
    : params.snapshot;
  const selectedProfileId = params.preferredProfileId ?? params.pinnedProfileId;
  const profileProvider =
    params.profileProvider ??
    (selectedProfileId
      ? (authStore.profiles[selectedProfileId]?.provider ??
        params.cfg.auth?.profiles?.[selectedProfileId]?.provider)
      : undefined);
  if (
    snapshot.pendingProviders?.length &&
    (selectedProfileId || preferredProfilesByProvider.size)
  ) {
    const authProvider = (provider: string) =>
      resolveProviderIdForAuth(provider, { config: params.cfg, metadataSnapshot });
    // Shared discovery does not describe a selected account's inventory.
    snapshot = {
      ...snapshot,
      pendingProviders: snapshot.pendingProviders.filter(
        (provider) =>
          !preferredProfilesByProvider.has(normalizeProviderId(provider)) &&
          (!selectedProfileId ||
            (profileProvider && authProvider(provider) !== authProvider(profileProvider))),
      ),
    };
  }
  const accountOutcomes = createAccountCatalogOutcomes(snapshot.providerOutcomes);
  const providerOutcomes = accountOutcomes.outcomes;
  const statusSource = snapshot;
  snapshot = {
    ...snapshot,
    providerOutcomes,
    get refreshFailed() {
      return statusSource.refreshFailed;
    },
    get refreshFailures() {
      return statusSource.refreshFailures;
    },
    get pendingProviders() {
      return statusSource.pendingProviders;
    },
  };
  // Share only stable provider/config indexes within this decision owner.
  // Account decisions are evaluated separately.
  const resolveOpenAIProviderRoutes = createProviderModelRoutesResolver({
    provider: "openai",
    config: params.cfg,
    env: process.env,
  });
  const catalogView = prepareModelCatalogView({
    ...params,
    snapshot,
    workspaceDir,
    profileProvider,
    resolveOpenAIProviderRoutes,
  });
  const nativeEvaluator = catalogView.evaluateNative;
  const isNativeAccountBound = (entry: ModelCatalogEntry) =>
    preferredProfilesByProvider.has(normalizeProviderId(entry.provider)) ||
    configuredPinForEntry(entry);
  const prepareNativePolicy: typeof catalogView.prepareNativePolicy = (entry, host, runtimeId) => {
    if (!isNativeAccountBound(entry)) {
      catalogView.prepareNativePolicy(entry, host, runtimeId);
    }
  };
  // A selected profile is host-owned auth, not evidence from the shared native
  // login; the harness evaluator already applies this rule to session pins.
  const evaluateNative: typeof nativeEvaluator = (entry, host, runtimeId) =>
    isNativeAccountBound(entry) ? host : nativeEvaluator(entry, host, runtimeId);
  // Retire the captured host evaluation so its caller prepares fresh facts.
  const authValidUntil = resolveAuthStoreReadOnlyValidUntil(authStore, Date.now());
  const isPluginAuthProvider = (provider: string) =>
    resolveProviderAuthScope({
      provider,
      config: params.cfg,
      workspaceDir,
      pluginMetadataSnapshot: metadataSnapshot,
    }) === "plugin";
  const pluginAuthRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  const hasPluginAuth = snapshot.entries.some((entry) => isPluginAuthProvider(entry.provider));
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  let normalizedPlugins: NormalizedPluginsConfig | undefined;
  const authResolver = createModelAuthAvailabilityResolver({
    ...createCatalogPluginAuth({
      cfg: params.cfg,
      workspaceDir,
      metadataSnapshot,
      pluginRegistry: params.pluginRegistry,
    }),
    cfg: params.cfg,
    agentId: params.agentId,
    authStore,
    agentDir,
    preparedCliRuntimeAuthDirectories: {
      agentDir,
      inheritedAuthDir: resolveLegacyInheritedAuthDir(params.cfg),
    },
    env: process.env,
    metadataSnapshot,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    preparedSyntheticAuthComplete:
      params.preparedSyntheticAuthComplete ?? isPreparedModelCatalogFull(params.snapshot),
    workspaceDir,
    syntheticAuthProviderRefs: metadataSnapshot.plugins
      .filter((plugin) =>
        isManifestPluginAvailableForControlPlane({
          snapshot: metadataSnapshot,
          plugin,
          config: params.cfg,
          normalizedConfig:
            params.cfg.plugins &&
            (normalizedPlugins ??= normalizePluginsConfig(params.cfg.plugins)),
        }),
      )
      .flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
    externalCliProviderIds: resolveExternalCliAuthScopeFromConfig(params.cfg)?.providerIds ?? [],
    preparedRuntimeAuthStore: authStore,
    routeResolverFactory: params.routeResolverFactory,
    resolveOpenAIProviderRoutes,
    accountListsModel: accountOutcomes.accountListsModel,
  });
  const evaluations = new Map<string, Map<string, ModelAuthAvailabilityEvaluation>>();
  const preferredProfileIdForCatalog = params.preferredProfileId || undefined;
  const pinnedProfileIdForCatalog = params.pinnedProfileId || undefined;
  const normalizeAuthProvider = (provider: string) =>
    resolveProviderIdForAuth(provider, { config: params.cfg, metadataSnapshot });
  const isSelectedProvider = (provider: string) =>
    !profileProvider || normalizeAuthProvider(profileProvider) === normalizeAuthProvider(provider);
  const pinnedProfileForEntry = (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
    (isSelectedProvider(entry.provider) ? pinnedProfileIdForCatalog : undefined) ??
    preferredProfilesByProvider.get(normalizeProviderId(entry.provider)) ??
    configuredPinForEntry(entry);
  const isUnlistedWildcardCliModel = createUnlistedClaudeCliWildcardCheck({
    cfg: params.cfg,
    agentId: params.agentId,
    outcomes: () => snapshot.providerOutcomes,
  });
  const evaluateStoredEntry = (
    entry: Pick<ModelCatalogEntry, "provider" | "id" | "api" | "baseUrl">,
    routeVariants?: readonly ModelCatalogEntry[],
    runtimeId?: string,
  ): ModelAuthAvailabilityEvaluation => {
    const identity = openAIModelCatalogRoutePolicy.resolveIdentity(entry);
    const observedRoutes = listModelCatalogObservedRoutes(routeVariants ?? [entry]);
    const cacheKey = JSON.stringify([
      modelKeyOf(entry),
      runtimeId,
      entry.api,
      entry.baseUrl,
      observedRoutes,
    ]);
    const pluginAuth = isPluginAuthProvider(entry.provider);
    const provider = normalizeProviderId(entry.provider);
    const cached = pluginAuth ? undefined : evaluations.get(provider)?.get(cacheKey);
    if (cached) {
      return cached;
    }
    const defaultProfileId = preferredProfilesByProvider.get(normalizeProviderId(entry.provider));
    const sameProvider = isSelectedProvider(entry.provider);
    const preferredProfileId =
      (sameProvider ? preferredProfileIdForCatalog : undefined) ?? defaultProfileId;
    // New sessions capture personal defaults with the same strength as explicit account pins.
    const pinnedProfileId = pinnedProfileForEntry(entry);
    const requestedRuntimeId =
      runtimeId ?? (sameProvider && profileProvider ? params.runtimeOverride : undefined);
    const resolved = {
      ...authResolver.evaluateRuntimeModelAuth(entry.provider, {
        modelId: identity?.id ?? entry.id,
        runtimeId: requestedRuntimeId,
        ...(provider === "openai" ? {} : { api: entry.api, baseUrl: entry.baseUrl }),
        ...(preferredProfileId ? { preferredProfileId } : {}),
        ...(pinnedProfileId ? { pinnedProfileId } : {}),
        observedRoutes,
      }),
      ...(requestedRuntimeId ? { requestedRuntimeId } : {}),
    };
    // The wildcard narrows only what native Claude CLI credentials supplied. A selected or
    // pinned API account answers for its own models, so a saved account choice keeps them.
    const listed =
      !requestedRuntimeId &&
      resolved.availability === true &&
      resolved.evidence === "runtime" &&
      isUnlistedWildcardCliModel(provider, identity?.id ?? entry.id)
        ? { ...resolved, availability: false }
        : resolved;
    // Stored credentials prove presence, not acceptance. Apply the live rejection only to the
    // profile discovery tested; widening it would hide routes backed by another valid profile.
    const evaluation: ModelAuthAvailabilityEvaluation = providerOutcomes.some(
      (outcome) =>
        outcome.status === "auth-rejected" &&
        outcome.rejectionScope !== "catalog" &&
        normalizeProviderId(outcome.provider) === provider &&
        (outcome.profileId === undefined || outcome.profileId === resolved.selectedProfileId),
    )
      ? {
          ...resolved,
          availability: false,
          unavailableReason: "auth-failed",
          unavailableUntil: undefined,
        }
      : listed;
    if (!pluginAuth) {
      const rows = evaluations.get(provider) ?? new Map<string, ModelAuthAvailabilityEvaluation>();
      rows.set(cacheKey, evaluation);
      evaluations.set(provider, rows);
    }
    return evaluation;
  };
  const missingPersonalPin =
    params.preferredProfileId &&
    isUserModelAuthProfileId(params.preferredProfileId) &&
    !authStore.profiles[params.preferredProfileId];
  const evaluateEntry: typeof evaluateStoredEntry = missingPersonalPin
    ? (entry, variants, runtimeId) =>
        profileProvider &&
        normalizeProviderId(profileProvider) !== normalizeProviderId(entry.provider)
          ? evaluateStoredEntry(entry, variants, runtimeId)
          : {
              availability: false,
              unavailableReason: "missing-auth",
              selectedProfileId: params.preferredProfileId,
              routeResolution: null,
            }
    : evaluateStoredEntry;
  const accountObservations: Array<() => boolean> = [];
  const ownerCurrentChecks = [
    () => !hasPluginAuth || getActiveSecretsRuntimeSnapshotRevisionState() === pluginAuthRevision,
    () => personalCatalog?.isCurrent() !== false,
    () => params.isCurrent?.() ?? params.observationConfig === undefined,
    () => accountObservations.every((current) => current()),
  ];
  const isCurrent = () =>
    Date.now() < authValidUntil && ownerCurrentChecks.every((check) => check());
  const accountCatalog = params.accountCatalog;
  const selections = new Map(
    [...preferredProfilesByProvider].map(([provider, profile]) => [profile, provider]),
  );
  if (selectedProfileId && profileProvider) {
    selections.set(selectedProfileId, normalizeProviderId(profileProvider));
  }
  if (
    configuredProfileId &&
    primaryEntry &&
    pinnedProfileForEntry(primaryEntry) === configuredProfileId
  ) {
    // Automatic session preferences can still own siblings; retain both account inventories.
    selections.set(configuredProfileId, normalizeProviderId(primaryEntry.provider));
  }
  const hasAccountCatalogSelections = accountCatalog !== undefined && selections.size > 0;
  let pendingAccountPreparations = 0;
  let pendingAccountPrepPromise: Promise<void> | undefined;
  let resolveAccountPrep: (() => void) | undefined;
  const getPendingAccountCatalogPreparation = () => pendingAccountPrepPromise;
  const notePendingAccountCatalogPreparation = () => {
    if (pendingAccountPreparations++ === 0) {
      pendingAccountPrepPromise = new Promise<void>((resolve) => {
        resolveAccountPrep = resolve;
      });
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (--pendingAccountPreparations === 0) {
        pendingAccountPrepPromise = undefined;
        resolveAccountPrep?.();
        resolveAccountPrep = undefined;
      }
    };
  };
  let accountCatalogEpoch = 0;
  let projectedCatalog: CatalogProjection | undefined;
  const prepareSelectedAccountCatalog = async (
    assertCurrent: () => void,
    options: {
      refresh?: boolean;
      withCurrent?: CurrentReadAuthority["withCurrent"];
      beforeRequest?: () => void;
    },
  ): Promise<void> => {
    if (!accountCatalog) {
      return;
    }
    const authority = { assertCurrent, withCurrent: options.withCurrent };
    for (const [profileId, providerId] of selections) {
      const credential = await withCurrentReadAuthority(
        authority,
        () => authStore.profiles[profileId],
      );
      if (!credential) {
        continue;
      }
      const request: Parameters<typeof accountCatalog.acquire>[0] = {
        profileId,
        credential,
        ...options,
        allowDiscovery: options.refresh === true,
        load: async () => {
          assertCurrent();
          const provider = params.pluginRegistry?.providers.find(
            ({ provider: candidate }) => normalizeProviderId(candidate.id) === providerId,
          )?.provider;
          if (!provider?.catalog) {
            return [];
          }
          const { loadSelectedProviderAccountCatalog } =
            await import("./models-config.providers.catalog-context.js");
          assertCurrent();
          const selectedRequest: Parameters<typeof loadSelectedProviderAccountCatalog>[0] = {
            provider,
            providerId,
            profileId,
            authStore,
            refresh: options.refresh,
            config: params.cfg,
            agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
            workspaceDir,
            isCurrent,
            assertCurrent,
            withCurrent: options.withCurrent,
            beforeRequest: options.beforeRequest,
          };
          return withCurrentReadAuthority(authority, () =>
            loadSelectedProviderAccountCatalog(selectedRequest),
          );
        },
      };
      const acquired = await withCurrentReadAuthority(authority, () =>
        accountCatalog.acquire(request),
      );
      await withCurrentReadAuthority(authority, () => {
        accountObservations.push(acquired.isCurrent);
        // A cold account cache is not a new observation. Retain the current
        // authenticated shared outcome until the account publishes a result.
        if (
          !acquired.hasPublishedCatalog ||
          !accountOutcomes.replace(providerId, profileId, acquired.outcomes)
        ) {
          return;
        }
        // Retire decisions for the changed provider and routes that use its auth alias.
        for (const provider of evaluations.keys()) {
          if (provider === providerId || normalizeAuthProvider(provider) === providerId) {
            evaluations.delete(provider);
          }
        }
        accountCatalogEpoch += 1;
        projectedCatalog = undefined;
      });
    }
  };
  const runtime = createCatalogDecisionRuntimeResolver({
    ...params,
    workspaceDir,
    cliRuntimeBindings,
    resolveOpenAIProviderRoutes,
    evaluateEntry,
    evaluateNative,
    prepareNativePolicy,
  });
  const projectCatalog = createCatalogProjectionReader({
    createView: () => createModelCatalogSnapshotView(params.cfg, snapshot),
    evaluateEntry,
    prepareNativePolicy,
    hasAccountCatalogSelections,
    readEpoch: () => accountCatalogEpoch,
    readPendingAccountPrep: getPendingAccountCatalogPreparation,
    readProjection: () => projectedCatalog,
    publishProjection(projection) {
      projectedCatalog = projection;
    },
    captureCurrent(authority) {
      const initiallyAuthValid = Date.now() < authValidUntil;
      const initialChecks = ownerCurrentChecks.map((check) => check());
      return {
        initiallyAuthValid,
        initiallyOwnerCurrent: initialChecks.every(Boolean),
        reassertCatalogScanCurrent() {
          authority?.assertCurrent?.();
          if (
            (initiallyAuthValid && Date.now() >= authValidUntil) ||
            ownerCurrentChecks.some((check, index) => initialChecks[index] && !check())
          ) {
            throw new PreparedModelRuntimePublicationSupersededError(
              "Model catalog changed while projecting catalog",
            );
          }
        },
      };
    },
    warmEntry(view, entry, host) {
      const runtimeId = runtime.prepareDecisionRuntime(entry, host)?.id ?? "openclaw";
      const selected = view.selectRuntimeEntry({ entry, runtimeId });
      view.project(selected.entry, host, selected.variants);
    },
    projectEntry(view, entry, host) {
      const evaluation = evaluateNative(entry, host);
      const runtimeId = runtime.resolveDecisionRuntime(entry, evaluation)?.id ?? "openclaw";
      const selected = view.selectRuntimeEntry({ entry, runtimeId });
      return view.project(selected.entry, evaluation, selected.variants).runtimeEntry;
    },
  });
  return {
    preparedPersonalCatalog: personalCatalog,
    projectCatalog,
    notePendingAccountCatalogPreparation,
    accountCatalog: params.accountCatalog,
    prepareSelectedAccountCatalog,
    hasPinnedAccount: (entry: Pick<ModelCatalogEntry, "provider" | "id">) =>
      pinnedProfileForEntry(entry) !== undefined,
    evaluateEntry,
    evaluateNative,
    prepareNativePolicy,
    ...runtime,
    resolveOpenAIProviderRoutes,
    snapshot,
    metadataSnapshot,
    authStore,
    authModes: params.preparedRuntimeAuthModes,
    authMaterializations: params.preparedRuntimeAuthMaterializations,
    cliRuntimeBindings,
    pluginRegistry: params.pluginRegistry,
    isCurrent,
    assertCurrent: () => {
      if (!isCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Model catalog changed while selecting runtimes",
        );
      }
    },
    observationConfig: params.observationConfig,
  };
}
