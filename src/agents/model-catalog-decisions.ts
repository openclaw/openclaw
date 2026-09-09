import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isManifestPluginAvailableForControlPlane } from "../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayAgentRuntime } from "../shared/session-types.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { listUserProfileAuthLinks } from "../state/user-model-accounts.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { resolveExternalCliAuthScopeFromConfig } from "./auth-profiles/external-cli-scope.js";
import { materializePersonalAuthProfile } from "./auth-profiles/personal-profiles.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { listCliRuntimeModelBackendBindings } from "./cli-backends.js";
import { resolveAgentHarnessAvailabilityDecision } from "./harness/availability.js";
import { createAgentHarnessCatalogEvaluator } from "./harness/model-catalog-readiness.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { buildAgentHarnessSupportContext, resolveAutoAgentHarnessId } from "./harness/support.js";
import {
  createModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityResolver,
  type ModelAuthAvailabilityEvaluation,
} from "./model-auth-availability.js";
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
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

function listEnabledSyntheticAuthProviderRefs(
  metadataSnapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): readonly string[] {
  return metadataSnapshot.plugins
    .filter((plugin) =>
      isManifestPluginAvailableForControlPlane({ snapshot: metadataSnapshot, plugin, config }),
    )
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

function createModelsListAuthResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  metadataSnapshot: PluginMetadataSnapshot;
  preparedAuthStore: AuthProfileStore;
  preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
  preparedRuntimeAuthMaterializations?: readonly RuntimeAuthMaterialization[];
  preparedSyntheticAuthComplete?: boolean;
  workspaceDir: string;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
}): ModelAuthAvailabilityResolver {
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  return createModelAuthAvailabilityResolver({
    cfg: params.cfg,
    agentId: params.agentId,
    authStore: params.preparedAuthStore,
    agentDir,
    workspaceDir: params.workspaceDir,
    env: process.env,
    metadataSnapshot: params.metadataSnapshot,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    preparedSyntheticAuthComplete: params.preparedSyntheticAuthComplete,
    skipSetupProviderFallback: true,
    syntheticAuthProviderRefs: listEnabledSyntheticAuthProviderRefs(
      params.metadataSnapshot,
      params.cfg,
    ),
    externalCliProviderIds: resolveExternalCliAuthScopeFromConfig(params.cfg)?.providerIds ?? [],
    preparedRuntimeAuthStore: params.preparedAuthStore,
    routeResolverFactory: params.routeResolverFactory,
  });
}

function createModelsListEntryEvaluator(params: {
  authResolver: ModelAuthAvailabilityResolver;
  providerOutcomes?: readonly ProviderCatalogOutcome[];
  preferredProfileId?: string;
  preferredProfilesByProvider?: ReadonlyMap<string, string>;
  pinnedProfileId?: string;
  profileProvider?: string;
  runtimeOverride?: string;
  normalizeAuthProvider: (provider: string) => string;
}): (
  entry: Pick<ModelCatalogEntry, "provider" | "id" | "api" | "baseUrl">,
  routeVariants?: readonly ModelCatalogEntry[],
  runtimeId?: string,
) => Promise<ModelAuthAvailabilityEvaluation> {
  const pending = new Map<string, Promise<ModelAuthAvailabilityEvaluation>>();
  return (entry, routeVariants, runtimeId) => {
    const identity = openAIModelCatalogRoutePolicy.resolveIdentity(entry);
    const observedRoutes = (routeVariants ?? [entry]).map(({ api, baseUrl }) => ({ api, baseUrl }));
    const cacheKey = JSON.stringify([
      resolveModelCatalogIdentityKey(entry),
      runtimeId,
      entry.api,
      entry.baseUrl,
      observedRoutes,
    ]);
    const cached = pending.get(cacheKey);
    if (cached) {
      return cached;
    }
    const next = Promise.resolve().then((): ModelAuthAvailabilityEvaluation => {
      const defaultProfileId = params.preferredProfilesByProvider?.get(
        normalizeProviderId(entry.provider),
      );
      const sameProvider =
        !params.profileProvider ||
        params.normalizeAuthProvider(params.profileProvider) ===
          params.normalizeAuthProvider(entry.provider);
      const preferredProfileId =
        (sameProvider ? params.preferredProfileId : undefined) ?? defaultProfileId;
      // New sessions capture personal defaults with the same strength as explicit account pins.
      const pinnedProfileId =
        (sameProvider ? params.pinnedProfileId : undefined) ?? defaultProfileId;
      const requestedRuntimeId =
        runtimeId ?? (sameProvider && params.profileProvider ? params.runtimeOverride : undefined);
      const resolved = {
        ...params.authResolver.evaluateRuntimeModelAuth(entry.provider, {
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
      return params.providerOutcomes?.some(
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
    });
    pending.set(cacheKey, next);
    return next;
  };
}

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
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  isCurrent?: () => boolean;
};

/** Builds requester/session auth views without changing shared catalog or credential snapshots. */
export function createModelCatalogDecisions(params: ModelCatalogDecisionParams) {
  // The Gateway owns one process-lifecycle plugin metadata snapshot. Carry it
  // through the whole projection so per-model normalization cannot rediscover it.
  const metadataSnapshot = params.metadataSnapshot;
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.cfg, params.agentId) ??
    resolveDefaultAgentWorkspaceDir();
  let authStore = params.preparedAuthStore;
  const preferredProfilesByProvider = new Map<string, string>();
  const personalProviders = new Set<string>();
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
  const snapshot = personalStaticEntries.length
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
  const nativeEvaluator = createAgentHarnessCatalogEvaluator({
    config: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir ?? resolveAgentDir(params.cfg, params.agentId),
    workspaceDir,
    preferredProfileId: params.preferredProfileId,
    pinnedProfileId: params.pinnedProfileId,
    profileProvider,
    pluginRegistry: params.pluginRegistry,
    isCurrent: params.isCurrent,
    observationConfig: params.observationConfig,
  });
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
  const authResolver = createModelsListAuthResolver({
    cfg: params.cfg,
    agentId: params.agentId,
    metadataSnapshot,
    preparedAuthStore: authStore,
    preparedRuntimeAuthModes: params.preparedRuntimeAuthModes,
    preparedRuntimeAuthMaterializations: params.preparedRuntimeAuthMaterializations,
    preparedSyntheticAuthComplete:
      params.preparedSyntheticAuthComplete ?? isPreparedModelCatalogFull(params.snapshot),
    workspaceDir,
    routeResolverFactory: params.routeResolverFactory,
  });
  const evaluateStoredEntry = createModelsListEntryEvaluator({
    authResolver,
    providerOutcomes: params.snapshot.providerOutcomes,
    preferredProfilesByProvider,
    runtimeOverride: params.runtimeOverride,
    normalizeAuthProvider: (provider) =>
      resolveProviderIdForAuth(provider, { config: params.cfg, metadataSnapshot }),
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.pinnedProfileId ? { pinnedProfileId: params.pinnedProfileId } : {}),
    profileProvider,
  });
  const missingPersonalPin = Boolean(
    params.preferredProfileId &&
    isUserModelAuthProfileId(params.preferredProfileId) &&
    !authStore.profiles[params.preferredProfileId],
  );
  const evaluateEntry: typeof evaluateStoredEntry = missingPersonalPin
    ? async (entry, variants, runtimeId) =>
        profileProvider &&
        normalizeProviderId(profileProvider) !== normalizeProviderId(entry.provider)
          ? evaluateStoredEntry(entry, variants, runtimeId)
          : {
              availability: false,
              unavailableReason: "missing-auth",
              routeResolution: null,
            }
    : evaluateStoredEntry;
  const isCurrent = () =>
    Date.now() < authValidUntil && (params.isCurrent?.() ?? params.observationConfig === undefined);
  return {
    evaluateEntry,
    evaluateNative,
    snapshot,
    metadataSnapshot,
    authStore,
    authModes: params.preparedRuntimeAuthModes,
    async runtimeChoices(
      entry: ModelCatalogEntry,
      variants: readonly ModelCatalogEntry[] = [entry],
    ): Promise<string[] | undefined> {
      const initial = await evaluateEntry(entry, variants);
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
        ...listCliRuntimeModelBackendBindings()
          .filter(
            (binding) =>
              normalizeProviderId(binding.provider) === normalizeProviderId(entry.provider),
          )
          .map((binding) => binding.runtime),
      ]);
      const choices: string[] = [];
      let unknown = false;
      for (const runtimeId of candidates) {
        const host = await evaluateEntry(entry, variants, runtimeId);
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
          !listCliRuntimeModelBackendBindings().some(
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
                preparedAuth: {
                  source: evaluation.runtimeAuth
                    ? "harness"
                    : evaluation.selectedProfileId
                      ? "profile"
                      : "direct",
                  mode: evaluation.selectedAuthMode,
                  requirement: route?.authRequirement,
                },
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
      preparedAuth: {
        source: params.evaluation.runtimeAuth
          ? ("harness" as const)
          : params.evaluation.selectedProfileId
            ? ("profile" as const)
            : ("direct" as const),
        mode: params.evaluation.selectedAuthMode,
        requirement: route?.authRequirement,
      },
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
