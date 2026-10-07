import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, type NormalizedPluginsConfig } from "../plugins/config-state.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../shared/current-read-authority.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { listUserProfileAuthLinks } from "../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../state/user-profile-events.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { resolveExternalCliAuthScopeFromConfig } from "./auth-profiles/external-cli-scope.js";
import { materializePersonalAuthProfile } from "./auth-profiles/personal-profiles.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { listCliRuntimeModelBackendBindings } from "./cli-backends.js";
import { resolveAgentHarnessAvailabilityDecision } from "./harness/availability.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { buildAgentHarnessSupportContext, resolveAutoAgentHarnessId } from "./harness/support.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
} from "./model-auth-availability.js";
import {
  createModelCatalogView,
  prepareModelCatalogView,
  selectModelCatalogRuntimeEntry,
} from "./model-catalog-view.js";
import { loadManifestModelCatalog } from "./model-catalog.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { dedupeModelCatalogEntries } from "./model-selection-shared.js";
import {
  createOpenAIModelRoutesResolver,
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { isPreparedModelCatalogFull } from "./prepared-model-runtime.full-catalog.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

export type ModelCatalogDecisionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir?: string;
  snapshot: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preparedSyntheticAuthComplete?: boolean;
  requesterProfileId?: string;
  pluginRegistry?: PluginRegistry;
  observationConfig?: OpenClawConfig;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  profileProvider?: string;
  runtimeOverride?: string;
  accountCatalog?: import("./prepared-model-runtime-auth.js").PreparedAccountCatalogAccess;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  isCurrent?: () => boolean;
};

/** Builds requester/session auth views without changing shared catalog or credential snapshots. */
export function createModelCatalogDecisions(params: ModelCatalogDecisionParams) {
  // The Gateway owns one process-lifecycle plugin metadata snapshot. Carry it
  // through the whole projection so per-model normalization cannot rediscover it.
  const metadataSnapshot = params.metadataSnapshot;
  const workspaceDir = params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, params.agentId);
  // Runtime choices are read after preparation; CLI backends belong to the owner's registry.
  const cliRuntimeBindings = params.pluginRegistry
    ? withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
        listCliRuntimeModelBackendBindings(),
      )
    : listCliRuntimeModelBackendBindings();
  let authStore = params.preparedAuthStore;
  const preferredProfilesByProvider = new Map<string, string>();
  const personalProviders = new Set<string>();
  if (
    !params.preferredProfileId &&
    params.requesterProfileId &&
    getActiveOpenClawStateDatabaseReadSnapshot()
  ) {
    throw new PreparedModelRuntimePublicationSupersededError(
      "Default account selection requires current link authority",
    );
  }
  const defaultLinksAreCurrent =
    !params.preferredProfileId && params.requesterProfileId
      ? captureUserProfileModelAccountLinksAuthority(
          captureOpenClawStateReadContext().admission,
          params.requesterProfileId,
        )
      : undefined;
  // A persisted session pin wins over the current viewer's links. Only these
  // explicit selections enter this private projection, never its shared owner.
  if (params.preferredProfileId && isUserModelAuthProfileId(params.preferredProfileId)) {
    authStore = materializePersonalAuthProfile(authStore, params.preferredProfileId);
    const provider = authStore.profiles[params.preferredProfileId]?.provider;
    if (provider) {
      personalProviders.add(normalizeProviderId(provider));
    }
  } else if (!params.preferredProfileId && params.requesterProfileId) {
    for (const link of listUserProfileAuthLinks(params.requesterProfileId)) {
      const selected = isUserModelAuthProfileId(link.authProfileId)
        ? materializePersonalAuthProfile(authStore, link.authProfileId)
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
  // Selected-account discovery is private to this prepared projection, never the shared inventory.
  const providerOutcomes = [...(snapshot.providerOutcomes ?? [])];
  const statusSource = snapshot;
  snapshot = {
    ...snapshot,
    providerOutcomes,
    get refreshFailed() {
      return statusSource.refreshFailed;
    },
    get pendingProviders() {
      return statusSource.pendingProviders;
    },
  };
  const nativeEvaluator = prepareModelCatalogView({
    ...params,
    snapshot,
    workspaceDir,
    profileProvider,
  }).evaluateNative;
  // A selected profile is host-owned auth, not evidence from the shared native
  // login; the harness evaluator already applies this rule to session pins.
  const evaluateNative: typeof nativeEvaluator = (entry, host, runtimeId) =>
    preferredProfilesByProvider.has(normalizeProviderId(entry.provider))
      ? host
      : nativeEvaluator(entry, host, runtimeId);
  // Store revisions do not advance when a token or failure window expires.
  // Retire the captured host evaluation so its caller prepares fresh facts.
  const preparedAt = Date.now();
  const authValidUntil = Math.min(
    ...[
      ...Object.values(authStore.profiles).map((profile) =>
        profile.type === "token" ? profile.expires : undefined,
      ),
      ...Object.values(authStore.usageStats ?? {}).flatMap((stats) => [
        stats.blockedUntil,
        stats.cooldownUntil,
        stats.disabledUntil,
      ]),
    ].filter((deadline): deadline is number => deadline !== undefined && deadline > preparedAt),
  );
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  let normalizedPlugins: NormalizedPluginsConfig | undefined;
  const authResolver = createModelAuthAvailabilityResolver({
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
  });
  const evaluations = new Map<string, ModelAuthAvailabilityEvaluation>();
  const preferredProfileIdForCatalog = params.preferredProfileId || undefined;
  const pinnedProfileIdForCatalog = params.pinnedProfileId || undefined;
  const runtimeOverride = params.runtimeOverride;
  const normalizeAuthProvider = (provider: string) =>
    resolveProviderIdForAuth(provider, { config: params.cfg, metadataSnapshot });
  const evaluateStoredEntry = (
    entry: Pick<ModelCatalogEntry, "provider" | "id" | "api" | "baseUrl">,
    routeVariants?: readonly ModelCatalogEntry[],
    runtimeId?: string,
  ): ModelAuthAvailabilityEvaluation => {
    const identity = openAIModelCatalogRoutePolicy.resolveIdentity(entry);
    const observedRoutes = (routeVariants ?? [entry]).map(({ api, baseUrl }) => ({ api, baseUrl }));
    const cacheKey = JSON.stringify([
      resolveModelCatalogIdentityKey(entry),
      runtimeId,
      entry.api,
      entry.baseUrl,
      observedRoutes,
    ]);
    const cached = evaluations.get(cacheKey);
    if (cached) {
      return cached;
    }
    const defaultProfileId = preferredProfilesByProvider.get(normalizeProviderId(entry.provider));
    const sameProvider =
      !profileProvider ||
      normalizeAuthProvider(profileProvider) === normalizeAuthProvider(entry.provider);
    const preferredProfileId =
      (sameProvider ? preferredProfileIdForCatalog : undefined) ?? defaultProfileId;
    // New sessions capture personal defaults with the same strength as explicit account pins.
    const pinnedProfileId =
      (sameProvider ? pinnedProfileIdForCatalog : undefined) ?? defaultProfileId;
    const requestedRuntimeId =
      runtimeId ?? (sameProvider && profileProvider ? runtimeOverride : undefined);
    const resolved = {
      ...authResolver.evaluateRuntimeModelAuth(entry.provider, {
        modelId: identity?.id ?? entry.id,
        runtimeId: requestedRuntimeId,
        ...(normalizeProviderId(entry.provider) === "openai"
          ? {}
          : { api: entry.api, baseUrl: entry.baseUrl }),
        ...(preferredProfileId ? { preferredProfileId } : {}),
        ...(pinnedProfileId ? { pinnedProfileId } : {}),
        observedRoutes,
      }),
      ...(requestedRuntimeId ? { requestedRuntimeId } : {}),
    };
    const provider = normalizeProviderId(entry.provider);
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
      : resolved;
    evaluations.set(cacheKey, evaluation);
    return evaluation;
  };
  const missingPersonalPin = Boolean(
    params.preferredProfileId &&
    isUserModelAuthProfileId(params.preferredProfileId) &&
    !authStore.profiles[params.preferredProfileId],
  );
  const evaluateEntry: typeof evaluateStoredEntry = missingPersonalPin
    ? (entry, variants, runtimeId) =>
        profileProvider &&
        normalizeProviderId(profileProvider) !== normalizeProviderId(entry.provider)
          ? evaluateStoredEntry(entry, variants, runtimeId)
          : {
              availability: false,
              unavailableReason: "missing-auth",
              routeResolution: null,
            }
    : evaluateStoredEntry;
  const accountObservations: Array<() => boolean> = [];
  const isCurrent = () =>
    Date.now() < authValidUntil &&
    defaultLinksAreCurrent?.() !== false &&
    (params.isCurrent?.() ?? params.observationConfig === undefined) &&
    accountObservations.every((current) => current());
  const prepareSelectedAccountCatalog = async (
    assertCurrent: () => void,
    options: {
      allowDiscovery: boolean;
      refresh?: boolean;
      withCurrent?: CurrentReadAuthority["withCurrent"];
      beforeRequest?: () => void;
    },
  ): Promise<void> => {
    const accountCatalog = params.accountCatalog;
    if (!accountCatalog) {
      return;
    }
    const authority = { assertCurrent, withCurrent: options.withCurrent };
    const selections = new Map(preferredProfilesByProvider);
    if (selectedProfileId && profileProvider) {
      selections.set(normalizeProviderId(profileProvider), selectedProfileId);
    }
    for (const [providerId, profileId] of selections) {
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
        providerOutcomes.splice(
          0,
          providerOutcomes.length,
          ...providerOutcomes.filter(
            (outcome) =>
              normalizeProviderId(outcome.provider) !== providerId ||
              outcome.profileId !== profileId,
          ),
          ...acquired.outcomes,
        );
      });
    }
  };
  let projectedCatalog: ModelCatalogEntry[] | undefined;
  return {
    projectCatalog: (authority?: CurrentReadAuthority) =>
      withCurrentReadAuthority(authority, () => {
        if (projectedCatalog) {
          return projectedCatalog;
        }
        const view = createModelCatalogView({
          cfg: params.cfg,
          catalog: snapshot.entries,
          routeVariants:
            snapshot.routeVariants.length > 0 ? snapshot.routeVariants : snapshot.entries,
        });
        const projection = view.logicalEntries.map((entry) => {
          const routeVariants = view.variantsOf(entry) ?? [entry];
          const host = evaluateEntry(entry, routeVariants);
          const evaluation = evaluateNative(entry, host);
          const runtimeId =
            resolveCatalogDecisionRuntime({
              cfg: params.cfg,
              agentId: params.agentId,
              entry,
              evaluation,
              pluginRegistry: params.pluginRegistry,
            })?.id ?? "openclaw";
          const selected = selectModelCatalogRuntimeEntry({ entry, routeVariants, runtimeId });
          return view.project(selected.entry, evaluation, selected.variants).runtimeEntry;
        });
        // Request authority belongs to this preparation, never the shared projector cache.
        if (!authority) {
          projectedCatalog = projection;
        }
        return projection;
      }),
    accountCatalog: params.accountCatalog,
    prepareSelectedAccountCatalog,
    evaluateEntry,
    evaluateNative,
    snapshot,
    metadataSnapshot,
    authStore,
    authModes: params.preparedRuntimeAuthModes,
    runtimeChoices(
      entry: ModelCatalogEntry,
      variants: readonly ModelCatalogEntry[] = [entry],
    ): string[] | undefined {
      const initial = evaluateEntry(entry, variants);
      const selected = resolveCatalogDecisionRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
        evaluation: initial,
        pluginRegistry: params.pluginRegistry,
      });
      const candidates = new Set([
        selected?.id ?? "openclaw",
        "openclaw",
        ...variants.flatMap((variant) => (variant.nativeRuntime ? [variant.nativeRuntime] : [])),
        ...(initial.routeResolution?.kind === "routes"
          ? initial.routeResolution.routes.flatMap(
              (route) => route.runtimePolicy?.compatibleIds ?? [],
            )
          : []),
        ...cliRuntimeBindings
          .filter(
            (binding) =>
              normalizeProviderId(binding.provider) === normalizeProviderId(entry.provider),
          )
          .map((binding) => binding.runtime),
      ]);
      const choices: string[] = [];
      let unknown = false;
      for (const runtimeId of candidates) {
        const host = evaluateEntry(entry, variants, runtimeId);
        const evaluation = evaluateNative(entry, host, runtimeId);
        if (evaluation.availability === undefined) {
          unknown = true;
        }
        if (evaluation.availability !== true) {
          continue;
        }
        const route = evaluation.selectedRoute;
        const policy = resolveAgentHarnessPolicy({
          config: params.cfg,
          agentId: params.agentId,
          provider: entry.provider,
          modelId: entry.id,
          modelApi: route?.api ?? entry.api,
          modelBaseUrl: route?.baseUrl ?? entry.baseUrl,
          requestTransportOverrides: route?.requestTransportOverrides,
        });
        if (policy.forcedByEnvironment && policy.runtime !== runtimeId) {
          continue;
        }
        const compatible = evaluation.selectedRoute?.runtimePolicy?.compatibleIds;
        if (compatible && !compatible.includes(runtimeId)) {
          continue;
        }
        if (evaluation.runtimeAuth && evaluation.runtimeAuth.id !== runtimeId) {
          continue;
        }
        if (
          runtimeId !== "openclaw" &&
          !cliRuntimeBindings.some(
            (binding) =>
              binding.runtime === runtimeId &&
              normalizeProviderId(binding.provider) === normalizeProviderId(entry.provider),
          )
        ) {
          const harness = params.pluginRegistry?.agentHarnesses.find(
            (registration) => registration.harness.id === runtimeId,
          )?.harness;
          if (!harness) {
            unknown ||= params.pluginRegistry === undefined;
            continue;
          }
          const supported = harness.supports(
            buildAgentHarnessSupportContext({
              config: params.cfg,
              agentId: params.agentId,
              provider: entry.provider,
              modelId: entry.id,
              requestedRuntime: runtimeId,
              modelProvider: {
                api: route?.api ?? entry.api,
                baseUrl: route?.baseUrl ?? entry.baseUrl,
                runtimePolicy: route?.runtimePolicy,
                requestTransportOverrides: route?.requestTransportOverrides,
                // Native observations select a route but do not supply host credentials.
                preparedAuth: evaluation.selectedCredential,
              },
            }),
          );
          if (!supported.supported) {
            continue;
          }
        }
        choices.push(runtimeId);
      }
      if (!isCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Model catalog changed while selecting runtimes",
        );
      }
      return choices.length === 0 && unknown ? undefined : choices;
    },
    authMaterializations: params.preparedRuntimeAuthMaterializations,
    cliRuntimeBindings,
    pluginRegistry: params.pluginRegistry,
    isCurrent,
    observationConfig: params.observationConfig,
  };
}

/** Public runtime and thinking consume this same route/account decision. */
export function resolveCatalogDecisionRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: ModelCatalogEntry;
  evaluation: ModelAuthAvailabilityEvaluation;
  pluginRegistry?: PluginRegistry;
}): GatewayAgentRuntime | undefined {
  const route = params.evaluation.selectedRoute;
  const context = {
    config: params.cfg,
    agentId: params.agentId,
    provider: params.entry.provider,
    modelId: params.entry.id,
    modelProvider: {
      api: route?.api ?? params.entry.api,
      baseUrl: route?.baseUrl ?? params.entry.baseUrl,
      requestTransportOverrides: route?.requestTransportOverrides,
      runtimePolicy: route?.runtimePolicy,
      preparedAuth: params.evaluation.selectedCredential,
    },
    preparedModelProvider: true,
  };
  const select = () => {
    const { policy } = resolveAgentHarnessAvailabilityDecision({
      ...context,
      mode: "projection",
      agentHarnessRuntimeOverride: params.evaluation.requestedRuntimeId,
    });
    return {
      policy,
      runtime:
        policy.runtime === "auto"
          ? (resolveAutoAgentHarnessId(context) ?? "openclaw")
          : policy.runtime,
    };
  };
  const selected = params.pluginRegistry
    ? withPluginRuntimeRegistryScope(params.pluginRegistry, select)
    : (() => {
        const policy = resolveAgentHarnessPolicy({
          ...context,
          modelApi: context.modelProvider.api,
          modelBaseUrl: context.modelProvider.baseUrl,
          requestTransportOverrides: context.modelProvider.requestTransportOverrides,
        });
        return {
          policy,
          runtime:
            params.evaluation.requestedRuntimeId ??
            (policy.runtime === "auto" ? "openclaw" : policy.runtime),
        };
      })();
  // Route projection must retain the native owner that supplied availability. Recomputing
  // implicit policy from its API-key route alone would relabel that owner as OpenClaw.
  const runtime =
    selected.policy.runtimeSource === "implicit" &&
    !selected.policy.forcedByEnvironment &&
    isDefaultAgentRuntimeId(params.evaluation.requestedRuntimeId)
      ? (params.evaluation.runtimeAuth?.id ?? selected.runtime)
      : selected.runtime;
  if (
    selected.policy.runtime === "auto" &&
    runtime === "openclaw" &&
    !params.evaluation.requestedRuntimeId
  ) {
    return undefined;
  }
  return {
    id: runtime,
    source: selected.policy.runtimeSource ?? "implicit",
  };
}
