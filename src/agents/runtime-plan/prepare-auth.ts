/**
 * Prepares route-aware auth forwarding for auxiliary agent-runtime calls.
 * Callers supply an already loaded credential snapshot; this module never
 * resolves secrets or loads a provider runtime.
 */
import { resolveMergedModelProviderConfig } from "../../config/model-provider-config.js";
import {
  pluginProviderAuthUnavailable,
  resolveProviderAuthScope,
} from "../../plugins/provider-auth-scope.js";
import { isPendingOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import {
  prependAuthProfilePin,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrderWithMetadata,
} from "../auth-profiles/order.js";
import { resolveStoredCredentialReadOnlyAvailability } from "../auth-profiles/read-only-availability.js";
import { createSelectedAuthProfileUnavailableError } from "../auth-profiles/selection-error.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
} from "../auth-profiles/usage-state.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../failover/error.js";
import { resolveProviderDirectAuthPlanningEvidence } from "../model-auth-env.js";
import { resolveProviderModelAuthPolicy } from "../model-auth-policy.js";
import {
  hasUsableCustomProviderApiKey,
  resolveProviderConfigSecretInput,
  resolveProviderEntryApiKeyProfileReference,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../model-auth-provider-config.js";
import { resolveModelProviderAuthConfig } from "../model-auth-provider-route.js";
import { prepareNativeCommandAuth } from "../model-native-command-auth.js";
import { resolveDefaultModelForAgent } from "../model-selection-config.js";
import { resolveOpenAIModelRoutes, selectOpenAIModelRouteAuth } from "../openai-model-routes.js";
import {
  buildProviderModelAuthDirectSource,
  buildProviderModelAuthSourcePlan,
  classifyProviderModelAuthSource,
  type ProviderModelAuthDirectSource,
  type ProviderModelAuthProfileSource,
  type ProviderModelAuthSource,
} from "../provider-model-auth-source-plan.js";
import {
  selectProviderModelAuthSources,
  resolveProviderModelRouteAuthRequirement,
} from "../provider-model-route-auth.js";
import { buildAgentRuntimeAuthPlan } from "./auth.js";
import type { PrepareAgentRuntimeAuthPlanParams } from "./prepare-auth.types.js";
import type {
  AgentRuntimeAuthPlan,
  PreparedAgentRuntimeAuth,
  PreparedAgentRuntimeAuthAttempt,
} from "./types.js";

function createAuthProfileCooldownError(
  params: PrepareAgentRuntimeAuthPlanParams,
  profileId: string,
): FailoverError {
  const reason =
    (params.authProfileStore &&
      resolveProfilesUnavailableReason({
        store: params.authProfileStore,
        profileIds: [profileId],
      })) ??
    "unknown";
  return new FailoverError(
    `Auth profile "${profileId}" is temporarily unavailable for ${params.provider}/${params.modelId}.`,
    {
      reason,
      status: resolveFailoverStatus(reason),
      code: AUTH_PROFILE_COOLDOWN_ERROR_CODE,
      provider: params.provider,
      model: params.modelId,
      profileId,
    },
  );
}

type LogicalAuthAttempt = Extract<
  ReturnType<typeof selectProviderModelAuthSources>,
  { kind: "selected" }
>["attempts"][number];

function prepareAuthAttempts<Attempt extends LogicalAuthAttempt>(
  attempts: readonly Attempt[],
  buildPlan: (attempt: Attempt | undefined, index: number) => AgentRuntimeAuthPlan,
): PreparedAgentRuntimeAuth {
  const prepared: PreparedAgentRuntimeAuthAttempt[] = attempts.map((attempt, index) => {
    const plan = buildPlan(attempt, index);
    return attempt.kind === "profile"
      ? { kind: "profile", plan, profileId: attempt.source.profileId }
      : {
          kind: "direct",
          plan,
          allowAuthProfileFallback: attempt.allowAuthProfileFallback,
          requiresPriorProfileAttempt: attempts
            .slice(0, index)
            .some((candidate) => candidate.kind === "profile"),
        };
  });
  const plan = prepared[0]?.plan ?? buildPlan(undefined, 0);
  return { plan, attempts: prepared.length > 0 ? prepared : [{ kind: "implicit", plan }] };
}

/** Prevents a direct fallback from bypassing a prepared profile tier. */
export function canRunPreparedAgentRuntimeAuthAttempt(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  priorProfileAttempted: boolean;
}): boolean {
  return (
    params.attempt.kind !== "direct" ||
    !params.attempt.requiresPriorProfileAttempt ||
    params.priorProfileAttempted
  );
}

/** Rechecks automatic cooldowns immediately before a prepared profile attempt. */
export function preparedAgentRuntimeProfileAttemptHasCandidate(params: {
  attempt: PreparedAgentRuntimeAuthAttempt;
  store: AuthProfileStore;
  modelId: string;
}): boolean {
  if (params.attempt.kind !== "profile") {
    return false;
  }
  const profileIds = params.attempt.plan.forwardedAuthProfileCandidateIds ?? [
    params.attempt.profileId,
  ];
  return profileIds.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, undefined, params.modelId),
  );
}

/** True when a prepared auth tuple can be reused for this exact compaction target. */
export function agentRuntimeAuthPlanMatchesTarget(
  plan: AgentRuntimeAuthPlan,
  target: { provider: string; modelId: string },
): boolean {
  const route = plan.modelRoute;
  const provider = route?.provider ?? plan.providerForAuth;
  const modelId = route?.modelId ?? plan.modelId;
  return (
    modelId !== undefined &&
    provider.trim().toLowerCase() === target.provider.trim().toLowerCase() &&
    modelId === target.modelId
  );
}

function resolveProfile(
  params: PrepareAgentRuntimeAuthPlanParams,
  profileId: string,
  options: { ignoreCooldown?: boolean } = {},
): ProviderModelAuthProfileSource {
  const credential = params.authProfileStore?.profiles[profileId];
  const configured = params.config?.auth?.profiles?.[profileId];
  const availability = credential
    ? resolveStoredCredentialReadOnlyAvailability({
        credential,
        cfg: params.config ?? {},
        env: params.env ?? process.env,
      })
    : undefined;
  const authFlow = credential?.type === "oauth" ? credential.authFlow : undefined;
  const policy =
    credential?.type === "oauth" && authFlow
      ? resolveProviderModelAuthPolicy({
          provider: credential.provider,
          mode: credential.type,
          authFlow,
        })
      : undefined;
  const pendingOAuthRefresh =
    credential?.type === "oauth" && isPendingOAuthRefreshFence(credential);
  return {
    kind: "profile",
    profileId,
    provider: credential?.provider ?? configured?.provider,
    mode: credential?.type ?? configured?.mode,
    ...(authFlow ? { authFlow, authRequirement: policy?.authRequirement } : {}),
    // Runtime materialization owns secret readiness; only proven-invalid facts are terminal here.
    readiness:
      policy?.compatible === false || (availability === false && !pendingOAuthRefresh)
        ? "unavailable"
        : "unknown",
    cooldown:
      !options.ignoreCooldown &&
      params.authProfileStore &&
      isProfileInCooldown(params.authProfileStore, profileId, undefined, params.modelId)
        ? "active"
        : "clear",
  };
}

/** Applies terminal provider-entry credential policy before route selection. */
function resolvePreparedProviderEntryApiKeyProfileReference(
  params: PrepareAgentRuntimeAuthPlanParams & { store: AuthProfileStore },
) {
  const reference = resolveProviderEntryApiKeyProfileReference({
    cfg: params.config,
    authAliasLookupParams: params,
    provider: params.provider,
    store: params.store,
  });
  if (reference.kind !== "profile") {
    return reference;
  }
  const eligibility = resolveAuthProfileEligibility({
    cfg: params.config,
    authAliasLookupParams: params,
    store: params.store,
    provider: params.provider,
    profileId: reference.profileId,
  });
  if (!eligibility.eligible) {
    throw new Error(
      `Per-entry apiKey profile "${reference.profileId}" has no usable credentials for ${params.provider}.`,
    );
  }
  if (isProfileInCooldown(params.store, reference.profileId, undefined, params.modelId)) {
    throw createAuthProfileCooldownError(
      { ...params, authProfileStore: params.store },
      reference.profileId,
    );
  }
  return reference;
}

/** Selects concrete provider routes and ordered credentials as one immutable preparation. */
export function prepareAgentRuntimeAuth(
  input: PrepareAgentRuntimeAuthPlanParams,
): PreparedAgentRuntimeAuth {
  const native = prepareNativeCommandAuth(input);
  if (native) {
    return native;
  }
  if (
    resolveProviderAuthScope({
      provider: input.provider,
      config: input.config,
      env: input.env,
      workspaceDir: input.workspaceDir,
      pluginMetadataSnapshot: input.metadataSnapshot,
    }) === "plugin"
  ) {
    if (input.requiredAuthProfileId !== undefined || input.sessionAuthProfileId !== undefined) {
      throw pluginProviderAuthUnavailable(
        input.provider,
        "agent profile pins cannot select plugin credentials",
      );
    }
    // Static ownership selects direct live auth before agent profiles, bindings or cooldowns.
    // The credential resolver still validates this generation's live plugin at use time.
    const plan = buildAgentRuntimeAuthPlan({
      provider: input.provider,
      modelId: input.modelId,
      config: input.config,
      env: input.env,
      workspaceDir: input.workspaceDir,
      metadataSnapshot: input.metadataSnapshot,
      harnessId: input.harnessId,
      harnessRuntime: input.harnessRuntime,
      allowHarnessAuthProfileForwarding: false,
      credentialSource: { kind: "direct", evidence: "synthetic", authorization: "declared" },
    });
    return {
      plan,
      attempts: [
        {
          kind: "direct",
          plan,
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: false,
        },
      ],
    };
  }
  const params = { ...input, config: resolveModelProviderAuthConfig(input) };
  const requestedProfileId = params.sessionAuthProfileId?.trim() || undefined;
  const lockedProfileId =
    params.requiredAuthProfileId ??
    (params.sessionAuthProfileSource === "user" || params.sessionAuthProfileSource === "user-link"
      ? requestedProfileId
      : undefined);
  const harnessOwnsOpenAIAuth =
    params.harnessId?.trim().toLowerCase() === "codex" ||
    params.harnessRuntime?.trim().toLowerCase() === "codex";
  const harnessAuthOwnerId = params.harnessId?.trim() || params.harnessRuntime?.trim();
  const runtimeAuthOwner =
    harnessOwnsOpenAIAuth && params.harnessAuthBootstrap === "harness" && harnessAuthOwnerId
      ? { id: harnessAuthOwnerId }
      : undefined;
  const harnessAllowsAuthProfileForwarding = params.allowHarnessAuthProfileForwarding !== false;
  if (lockedProfileId && !harnessAllowsAuthProfileForwarding) {
    throw new Error(
      `Auth profile "${lockedProfileId}" cannot be forwarded to the selected agent harness. Configure that harness's native account instead.`,
    );
  }
  const store = params.authProfileStore;
  const authProfileSelectionProvider = harnessOwnsOpenAIAuth ? "openai" : params.provider;
  if (lockedProfileId) {
    const eligibility = store
      ? resolveAuthProfileEligibility({
          cfg: params.config,
          authAliasLookupParams: params,
          store,
          provider: authProfileSelectionProvider,
          profileId: lockedProfileId,
          includePendingOAuthRefresh: true,
        })
      : { eligible: false };
    if (!eligibility.eligible) {
      if (
        !store?.profiles[lockedProfileId] &&
        params.config?.auth?.profiles?.[lockedProfileId]?.mode !== "aws-sdk"
      ) {
        throw createSelectedAuthProfileUnavailableError({
          profileId: lockedProfileId,
          provider: authProfileSelectionProvider,
          modelId: params.modelId,
        });
      }
      throw new Error(
        `Auth profile "${lockedProfileId}" is not configured for ${authProfileSelectionProvider}.`,
      );
    }
  }

  const configuredProvider = resolveMergedModelProviderConfig(params.config, params.provider);
  const configuredAuthMode =
    lockedProfileId || !harnessAllowsAuthProfileForwarding ? undefined : configuredProvider?.auth;
  const configuredAwsSdkAuth = configuredAuthMode === "aws-sdk";
  const providerApiKeySecretRef = harnessAllowsAuthProfileForwarding
    ? resolveProviderConfigSecretInput(params.config, params.provider).ref
    : undefined;
  const providerHasApiKeySecretRef = Boolean(providerApiKeySecretRef);
  const providerBinding =
    harnessAllowsAuthProfileForwarding && !lockedProfileId && store && !configuredAwsSdkAuth
      ? resolvePreparedProviderEntryApiKeyProfileReference({
          ...params,
          store,
        })
      : { kind: "none" as const };
  if (providerBinding.kind === "profile-incompatible") {
    throw new Error(
      `Per-entry apiKey "${providerBinding.profileId}" is not a compatible bearer profile for ${params.provider}.`,
    );
  }
  const boundProfileId = providerBinding.kind === "profile" ? providerBinding.profileId : undefined;
  const providerHasUsableMarker =
    providerBinding.kind === "marker" &&
    hasUsableCustomProviderApiKey(params.config, params.provider, params.env);
  const providerHasDirectMaterial =
    !configuredAwsSdkAuth &&
    (providerBinding.kind === "literal" || providerHasUsableMarker || providerHasApiKeySecretRef);
  const explicitConfigApiKeyAuth = shouldPreferExplicitConfigApiKeyAuth(
    params.config,
    params.provider,
  );
  const providerBindingSuppressesProfiles =
    (providerBinding.kind === "literal" && explicitConfigApiKeyAuth) ||
    providerHasUsableMarker ||
    providerHasApiKeySecretRef;
  const providerBindingNeedsNonProfileFallback =
    providerHasDirectMaterial && !providerBindingSuppressesProfiles;
  // Explicit auth owns the physical route; apiKey is only its bearer material.
  const selectedConfiguredAuthMode =
    configuredAuthMode ?? (providerHasDirectMaterial ? "api-key" : undefined);
  const selectedProfileId =
    params.requiredAuthProfileId ??
    boundProfileId ??
    (params.allowAuthProfileFallback === false ? lockedProfileId : undefined);
  const resolvedAutomaticOrder =
    !harnessAllowsAuthProfileForwarding ||
    selectedProfileId ||
    providerBindingSuppressesProfiles ||
    configuredAwsSdkAuth ||
    !store
      ? {
          profileIds: selectedProfileId ? [selectedProfileId] : [],
          hasExplicitOrder: false,
        }
      : resolveAuthProfileOrderWithMetadata({
          cfg: params.config,
          authAliasLookupParams: params,
          store,
          provider: authProfileSelectionProvider,
          preferredProfile: requestedProfileId,
          forModel: params.modelId,
          readinessMode: "read-only",
          includePendingOAuthRefresh: true,
        });
  const automaticOrderResolution = prependAuthProfilePin(resolvedAutomaticOrder, lockedProfileId);
  const providerPreferredProfileId =
    harnessAllowsAuthProfileForwarding &&
    !selectedProfileId &&
    !lockedProfileId &&
    !providerBindingSuppressesProfiles &&
    !configuredAwsSdkAuth &&
    store
      ? params.resolveProviderPreferredProfileId?.({
          config: params.config,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          provider: params.provider,
          modelId: params.modelId,
          preferredProfileId: requestedProfileId,
          lockedProfileId: undefined,
          profileOrder: automaticOrderResolution.profileIds,
          authStore: store,
        })
      : undefined;
  const resolvedOrderedProfileIds =
    providerPreferredProfileId &&
    automaticOrderResolution.profileIds.includes(providerPreferredProfileId)
      ? [
          providerPreferredProfileId,
          ...automaticOrderResolution.profileIds.filter(
            (profileId) => profileId !== providerPreferredProfileId,
          ),
        ]
      : automaticOrderResolution.profileIds;
  const directSource = (
    mode: string | undefined,
    evidence: ProviderModelAuthDirectSource["evidence"] = providerBinding.kind === "marker" &&
    providerHasUsableMarker
      ? providerBinding.evidence
      : providerApiKeySecretRef?.source === "env"
        ? "environment"
        : "provider-config",
    availability?: boolean,
    authorization: ProviderModelAuthDirectSource["authorization"] = "declared",
  ) => buildProviderModelAuthDirectSource({ mode, evidence, availability, authorization });
  const directPlanningCandidate = harnessAllowsAuthProfileForwarding
    ? resolveProviderDirectAuthPlanningEvidence(
        authProfileSelectionProvider,
        params.env ?? process.env,
        {
          config: params.config,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: params.metadataSnapshot,
        },
      )
    : null;
  // A setup hint does not supply a credential for a harness-owned login.
  const directPlanningEvidence =
    directPlanningCandidate?.kind === "setup-provider" &&
    (params.harnessAuthBootstrap === "harness" ||
      authProfileSelectionProvider.trim().toLowerCase() === "openai")
      ? null
      : directPlanningCandidate;
  const directPlanningMode = directPlanningEvidence
    ? (configuredAuthMode ?? directPlanningEvidence.mode)
    : undefined;
  // Provenance ("where was it found") is not authorization ("may it be used
  // here"). A credential found in the environment is still *declared* when the
  // provider entry points at it — a literal apiKey, a `${VAR}` marker, or a
  // SecretRef naming a canonical variable. Only a credential that nothing in
  // config references is ambient, and only ambient credentials are restricted.
  const fallbackIsAmbientCredential =
    directPlanningEvidence?.kind === "environment" && !providerHasDirectMaterial;
  const fallbackDirectSource = directPlanningMode
    ? directSource(
        directPlanningMode,
        directPlanningEvidence?.kind === "environment" ? "environment" : "runtime",
        directPlanningEvidence?.kind === "environment" ? true : undefined,
        fallbackIsAmbientCredential ? "ambient" : "declared",
      )
    : providerBindingNeedsNonProfileFallback
      ? directSource(selectedConfiguredAuthMode)
      : undefined;
  const automaticRouteAuthMode =
    fallbackDirectSource && !providerBindingSuppressesProfiles && !configuredAuthMode
      ? undefined
      : selectedConfiguredAuthMode;
  const ownership = selectedProfileId
    ? {
        reason:
          selectedProfileId === lockedProfileId
            ? ("runtime-binding" as const)
            : ("provider-binding" as const),
        source: resolveProfile(params, selectedProfileId, { ignoreCooldown: true }),
      }
    : configuredAwsSdkAuth
      ? {
          reason: "configured-auth" as const,
          source: directSource("aws-sdk", "aws-sdk"),
        }
      : providerBindingSuppressesProfiles
        ? {
            reason: "configured-auth" as const,
            source: directSource(selectedConfiguredAuthMode),
          }
        : undefined;
  const sourcePlan = buildProviderModelAuthSourcePlan({
    ...(ownership ? { ownership } : {}),
    profiles: resolvedOrderedProfileIds.map((profileId) => resolveProfile(params, profileId)),
    ...(lockedProfileId || providerPreferredProfileId
      ? { preferredProfileId: lockedProfileId ?? providerPreferredProfileId }
      : {}),
    explicitOrder: automaticOrderResolution.hasExplicitOrder,
    preserveProfilePriority: Boolean(lockedProfileId),
    ...(fallbackDirectSource ? { fallback: fallbackDirectSource } : {}),
    allowCooldown: params.allowTransientCooldownProbe,
  });
  const pinnedSource =
    sourcePlan.kind === "required"
      ? sourcePlan.source
      : sourcePlan.orderedProfiles.find((source) => source.profileId === lockedProfileId);
  const resolution = resolveOpenAIModelRoutes({
    provider: params.provider,
    modelId: params.modelId,
    api: params.modelApi,
    baseUrl: params.modelBaseUrl,
    observedRoutes: params.observedRoutes,
    config: params.config,
    agentId: params.agentId,
    primaryModel:
      !params.routeIntent && params.config
        ? resolveDefaultModelForAgent({
            cfg: params.config,
            agentId: params.agentId,
            allowManifestNormalization: false,
            allowPluginNormalization: false,
          })
        : undefined,
    resolveProfileAuthMode: (profileId) => params.authProfileStore?.profiles[profileId]?.type,
    resolveProfileAuthFlow: (profileId) => {
      const credential = params.authProfileStore?.profiles[profileId];
      return credential?.type === "oauth" ? credential.authFlow : undefined;
    },
    routeIntent: params.routeIntent,
    pinnedAuthRequirement: resolveProviderModelRouteAuthRequirement(
      sourcePlan.kind === "required"
        ? sourcePlan.source.mode
        : (pinnedSource?.mode ?? configuredAuthMode),
      pinnedSource?.kind === "profile" ? pinnedSource.authRequirement : undefined,
    ),
    env: params.env,
    requestTransportOverrides: params.requestTransportOverrides,
  });
  const authPlanParams = {
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    env: params.env,
    workspaceDir: params.workspaceDir,
    metadataSnapshot: params.metadataSnapshot,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessRuntime,
    allowHarnessAuthProfileForwarding: harnessAllowsAuthProfileForwarding,
  };
  const buildAttemptPlan = (
    source: ProviderModelAuthSource | undefined,
    candidateIds: string[] | undefined,
    modelRoute?: AgentRuntimeAuthPlan["modelRoute"],
  ) => {
    const profile = source?.kind === "profile" ? source : undefined;
    return buildAgentRuntimeAuthPlan({
      ...authPlanParams,
      authProfileProvider: profile?.provider,
      authProfileFlow: profile?.authFlow,
      authProfileMode:
        profile?.mode ?? (source?.kind === "direct" ? source.mode : selectedConfiguredAuthMode),
      sessionAuthProfileId: profile?.profileId,
      sessionAuthProfileSource: profile
        ? profile.profileId === lockedProfileId
          ? params.requiredAuthProfileId
            ? (params.sessionAuthProfileSource ?? "auto")
            : "user"
          : "auto"
        : undefined,
      sessionAuthProfileCandidateIds: candidateIds,
      credentialSource: source ? classifyProviderModelAuthSource(source) : { kind: "none" },
      modelRoute,
    });
  };
  const rejectionError = (
    decision: Extract<ReturnType<typeof selectOpenAIModelRouteAuth>, { kind: "rejected" }>,
  ) =>
    decision.reason === "all-cooldown" && decision.source
      ? createAuthProfileCooldownError(params, decision.source.profileId)
      : new Error(decision.message);
  const assertForwardedProfile = (profileId: string | undefined, plan: AgentRuntimeAuthPlan) => {
    if (profileId && harnessOwnsOpenAIAuth && plan.forwardedAuthProfileId !== profileId) {
      throw new Error(`Auth profile "${profileId}" cannot be forwarded to the codex runtime.`);
    }
  };
  if (!resolution || resolution.kind === "indeterminate") {
    const sourceDecision = selectProviderModelAuthSources({
      provider: authProfileSelectionProvider,
      plan: sourcePlan,
    });
    if (sourceDecision.kind === "rejected") {
      throw rejectionError(sourceDecision);
    }
    const buildGenericPlan = (
      attempt: (typeof sourceDecision.attempts)[number] | undefined,
      candidateIndex: number,
    ) => {
      const candidateIds = sourceDecision.attempts
        .slice(candidateIndex)
        .flatMap((candidate) => (candidate.kind === "profile" ? [candidate.source.profileId] : []));
      return buildAttemptPlan(attempt?.source, candidateIds.length > 0 ? candidateIds : undefined);
    };
    const prepared = prepareAuthAttempts(sourceDecision.attempts, buildGenericPlan);
    assertForwardedProfile(selectedProfileId, prepared.plan);
    return prepared;
  }
  if (resolution.kind === "incompatible") {
    throw new Error(resolution.message);
  }
  const toPreparedRoute = (route: (typeof resolution.routes)[number]) => ({
    provider: params.provider,
    modelId: params.modelId,
    api: route.api,
    baseUrl: route.baseUrl,
    authRequirement: route.authRequirement,
    requestTransportOverrides: route.requestTransportOverrides,
    runtimePolicy: route.runtimePolicy,
  });
  const routeAuthDecision = selectOpenAIModelRouteAuth({
    resolution,
    sourcePlan,
    configuredAuthMode: automaticRouteAuthMode,
    ...(runtimeAuthOwner ? { runtimeAuthOwner } : {}),
    ...(runtimeAuthOwner && configuredProvider === undefined
      ? { allowNativeAuthOnSingleRoute: true }
      : {}),
  });
  if (routeAuthDecision.kind === "deferred") {
    const plan = buildAgentRuntimeAuthPlan({
      ...authPlanParams,
      deferredRouteSupport: routeAuthDecision.routeSupport,
    });
    return { plan, attempts: [{ kind: "implicit", plan }] };
  }
  if (routeAuthDecision.kind !== "selected") {
    throw rejectionError(routeAuthDecision);
  }
  const buildRoutedPlan = (attempt: (typeof routeAuthDecision.attempts)[number] | undefined) => {
    const route = attempt?.route ?? routeAuthDecision.selection.route;
    return buildAttemptPlan(
      attempt?.source,
      attempt?.kind === "profile" ? [...attempt.sameRouteProfileIds] : undefined,
      toPreparedRoute(route),
    );
  };
  const prepared = prepareAuthAttempts(routeAuthDecision.attempts, buildRoutedPlan);
  for (const attempt of prepared.attempts) {
    if (attempt.kind !== "implicit") {
      assertForwardedProfile(attempt.profileId, attempt.plan);
    }
  }
  return prepared;
}
