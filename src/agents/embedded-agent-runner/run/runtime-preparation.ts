import { readSourceReplyDeliveryRuntime } from "../../../auto-reply/reply/source-reply-delivery-runtime.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { resolveProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import { resolvePreparedRunAdmission } from "../../admitted-run-context.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import { resolvePreparedModelThinkingCompat } from "../../model-catalog-lookup.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { resolveProviderEndpoint } from "../../provider-attribution.js";
import { getModelProviderRequestRouteFacts } from "../../provider-request-config.js";
import {
  hasPreparedAuthAttemptModelMetadata,
  resolveCredentialScopedAuthAttemptModelDecision,
} from "../../runtime-plan/credential-scoped-model.js";
import {
  canRunPreparedAgentRuntimeAuthAttempt,
  type PreparedAgentRuntimeAuthAttempt,
} from "../../runtime-plan/prepare-auth.js";
import { resolveCandidateThinkingLevel } from "../../thinking-runtime.js";
import { log } from "../logger.js";
import { formatEmbeddedRunStageSummary } from "./attempt-stage-timing.js";
import {
  createEmbeddedRunAuthController,
  createEmbeddedAuthProfileAdmission,
  type EmbeddedRunAuthState,
} from "./auth-controller.js";
import { prepareEmbeddedRunAuthPlan } from "./auth-plan.js";
import { createScopedAuthProfileStore } from "./auth-store.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveEmbeddedRunEffectiveModel, selectEmbeddedRunHarness } from "./model-harness.js";
import { resolveEmbeddedRunModelSetup } from "./model-setup.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { resolveInitialThinkLevel } from "./runtime-resolution.js";

export async function prepareEmbeddedRunRuntime(input: {
  assertCurrent: () => void;
  runParams: RunEmbeddedAgentInternalParams;
  sessionAdmission?: Parameters<typeof resolveEmbeddedRunModelSetup>[0]["sessionAdmission"];
  provider: string;
  modelId: string;
  agentDir: string;
  workspaceDir: string;
  globalLane: string;
  hookRunner: Parameters<typeof resolveEmbeddedRunModelSetup>[0]["hookRunner"];
  hookContext: Parameters<typeof resolveEmbeddedRunModelSetup>[0]["hookContext"];
  markStartupStage: (stage: string) => void;
  notifyExecutionPhase: (
    phase: Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0]["phase"],
    context?: Omit<Parameters<NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>>[0], "phase">,
  ) => void;
  fallbackConfigured: boolean;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}) {
  const params = input.runParams;
  const modelSetup = await resolveEmbeddedRunModelSetup({
    assertCurrent: input.assertCurrent,
    runParams: params,
    sessionAdmission: input.sessionAdmission,
    provider: input.provider,
    modelId: input.modelId,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
    globalLane: input.globalLane,
    hookRunner: input.hookRunner,
    hookContext: input.hookContext,
    onHooksResolved: () => input.markStartupStage("hooks"),
    preparedModelRuntime: input.preparedModelRuntime,
  });
  const pluginMetadataSnapshot = input.preparedModelRuntime?.metadataSnapshot;
  const {
    provider,
    modelId,
    requestedModelId,
    modelSelectionChangedByHook,
    requestStreamTransportOverrides,
    expectedHarnessArtifact,
    pinnedHarnessId,
    nativeModelOwned,
    assertNativeModelSelectionCurrent,
    observedRoutes,
    nativeSessionRuntime,
    modelConfigProvider,
    model,
    authStorage,
    modelRegistry,
  } = modelSetup;
  let agentHarness = modelSetup.agentHarness;
  let preparedThinkingCapabilityReady = false;
  const resolveEffectiveModel = (candidate: typeof model) =>
    resolveEmbeddedRunEffectiveModel({
      runParams: params,
      provider,
      modelConfigProvider,
      modelId,
      agentHarnessId: agentHarness.id,
      runtimeModel: candidate,
      nativeModelOwned,
      requestStreamTransportOverrides,
      pinnedHarnessId,
    });
  let resolvedRuntimeModel = resolveEffectiveModel(model);
  const models: EmbeddedRunAuthState["models"] = {
    runtime: model,
    effective: resolvedRuntimeModel.effectiveModel,
  };
  const applyResolvedRuntimeModel = (
    candidate: typeof model,
    resolvedCandidate?: ReturnType<typeof resolveEffectiveModel>,
  ) => {
    const preparedThinkingCompat = preparedThinkingCapabilityReady
      ? resolvePreparedModelThinkingCompat({
          capability: params.modelThinkingCapability,
          model: candidate,
          agentRuntime: agentHarness.id,
        })
      : undefined;
    const resolvedModel = preparedThinkingCompat
      ? { ...candidate, compat: { ...candidate.compat, ...preparedThinkingCompat } }
      : candidate;
    resolvedRuntimeModel =
      resolvedModel === candidate && resolvedCandidate
        ? resolvedCandidate
        : resolveEffectiveModel(resolvedModel);
    models.runtime = resolvedModel;
    models.effective = resolvedRuntimeModel.effectiveModel;
  };
  const selectHarness = (
    candidate: typeof model,
    attempts?: readonly PreparedAgentRuntimeAuthAttempt[],
  ) =>
    nativeSessionRuntime?.auth === "native"
      ? nativeSessionRuntime.harness
      : selectEmbeddedRunHarness({
          runParams: params,
          provider,
          modelId,
          model: candidate,
          attempts,
          requestStreamTransportOverrides,
          pinnedHarnessId,
        });
  input.markStartupStage("model-resolution");
  input.notifyExecutionPhase("model_resolution", { provider, model: modelId });

  agentHarness = selectHarness(models.effective);
  let pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
  const authStages = log.isEnabled("trace") ? createStageTimingTracker(Date.now) : undefined;
  const preparedAuthPlan = await prepareEmbeddedRunAuthPlan({
    assertCurrent: input.assertCurrent,
    runParams: params,
    provider,
    modelId,
    model,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
    requestStreamTransportOverrides,
    nativeModelOwned,
    observedRoutes,
    nativeSessionRuntime,
    authStorage,
    modelRegistry,
    preparedModelRuntime: input.preparedModelRuntime,
    getAgentHarness: () => agentHarness,
    setAgentHarness: (nextHarness) => {
      agentHarness = nextHarness;
      pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
    },
    getRuntimeModel: () => models.runtime,
    getEffectiveModel: () => models.effective,
    applyResolvedRuntimeModel,
    selectHarnessForPreparedAttempts: selectHarness,
    markStage: (stage) => authStages?.mark(stage),
  });
  const {
    attemptAuthProfileStore,
    lockedProfileId,
    preferredProfileId,
    providerUsesProfileScopedModelMetadata,
    materializeAuthPlan,
    materializeAuthPlanUncached,
    preparedAuthAttempts,
  } = preparedAuthPlan;
  let { activePreparedAuthPlan } = preparedAuthPlan;
  preparedThinkingCapabilityReady = true;
  applyResolvedRuntimeModel(models.runtime);
  const genericCompactionRecoveryAllowed = !pluginHarnessOwnsTransport;
  const profileCandidates = preparedAuthAttempts.map((attempt) => attempt.profileId);
  const forwardedPluginHarnessProfileId = pluginHarnessOwnsTransport
    ? activePreparedAuthPlan.forwardedAuthProfileId
    : undefined;
  const requestedThinkLevel = resolveInitialThinkLevel({
    requested: params.thinkLevel,
    config: params.config,
    agentId: params.agentId,
    provider,
    modelId,
    model: models.effective,
  });
  const initialThinkLevel = modelSelectionChangedByHook
    ? (resolveCandidateThinkingLevel({
        cfg: params.config,
        provider,
        modelId,
        level: requestedThinkLevel,
        catalog: [
          {
            provider,
            id: modelId,
            api: models.effective.api,
            reasoning: models.effective.reasoning,
            params: models.effective.params,
            compat: models.effective.compat,
          },
        ],
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentRuntime: agentHarness.id,
      }) ?? requestedThinkLevel)
    : requestedThinkLevel;
  const attemptedThinking = new Set<ThinkLevel>();
  const authState: EmbeddedRunAuthState = {
    models,
    thinkLevel: initialThinkLevel,
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
  };
  const pluginHarnessOwnsAuthBootstrap =
    pluginHarnessOwnsTransport && agentHarness.authBootstrap === "harness";
  const preparedApiKeyRoute = activePreparedAuthPlan.modelRoute?.authRequirement === "api-key";
  const pluginHarnessHasPreparedApiKeyAttempt = preparedAuthAttempts.some(
    (attempt) => attempt.plan.modelRoute?.authRequirement === "api-key",
  );
  const pluginHarnessNeedsOpenClawAuthBootstrap =
    pluginHarnessOwnsTransport &&
    (preparedApiKeyRoute ||
      (!pluginHarnessOwnsAuthBootstrap &&
        preparedAuthAttempts.some((attempt) => attempt.kind !== "implicit")));
  const findPreparedAuthAttempt = (profileId: string | undefined, attemptIndex?: number) => {
    const attempt =
      attemptIndex === undefined
        ? preparedAuthAttempts.find((candidate) => candidate.profileId === profileId)
        : preparedAuthAttempts[attemptIndex];
    return attempt?.profileId === profileId ? attempt : undefined;
  };
  let preparedProfileAttempted = false;
  const prepareAuthAttempt = async (attempt: (typeof preparedAuthAttempts)[number]) => {
    if (
      !canRunPreparedAgentRuntimeAuthAttempt({
        attempt,
        priorProfileAttempted: preparedProfileAttempted,
      })
    ) {
      throw new Error(
        `Prepared direct auth fallback cannot bypass unavailable profiles for ${provider}/${modelId}.`,
      );
    }
    const modelDecision = resolveCredentialScopedAuthAttemptModelDecision({
      attempt,
      priorProfileAttempted: preparedProfileAttempted,
      requestedProfileId: params.authProfileId,
      providerUsesProfileScopedModelMetadata,
    });
    const nextRuntimeModel = modelDecision.shouldMaterialize
      ? modelDecision.forceResolve
        ? await materializeAuthPlanUncached(attempt.plan, true)
        : await materializeAuthPlan(attempt.plan)
      : models.runtime;
    const nextResolvedModel = resolveEffectiveModel(nextRuntimeModel);
    const nextHarness = selectHarness(nextResolvedModel.effectiveModel, preparedAuthAttempts);
    if (nextHarness.id !== agentHarness.id) {
      throw new Error(
        `Prepared auth retry changed the selected agent harness for ${provider}/${modelId}.`,
      );
    }
    preparedProfileAttempted ||= attempt.kind === "profile";
    return {
      runtimeModel: nextRuntimeModel,
      authRequirement: modelDecision.authRequirement,
      allowAuthProfileFallback: attempt.allowAuthProfileFallback,
      commit() {
        applyResolvedRuntimeModel(nextRuntimeModel, nextResolvedModel);
        activePreparedAuthPlan = attempt.plan;
      },
    };
  };
  const hasPreparedAuthAttemptMetadata = hasPreparedAuthAttemptModelMetadata({
    attempts: preparedAuthAttempts,
    providerUsesProfileScopedModelMetadata,
  });
  const prepareModelForAuthProfile =
    hasPreparedAuthAttemptMetadata &&
    (!pluginHarnessOwnsAuthBootstrap || pluginHarnessHasPreparedApiKeyAttempt)
      ? async (profileId: string | undefined, attemptIndex?: number) => {
          const attempt = findPreparedAuthAttempt(profileId, attemptIndex);
          if (!attempt) {
            throw new Error(
              `Auth profile "${profileId ?? "(none)"}" is outside the prepared attempts for ${provider}/${modelId}.`,
            );
          }
          const prepared = await prepareAuthAttempt(attempt);
          if (attempt.plan.modelRoute && !prepared.authRequirement) {
            throw new Error(`Prepared route metadata is missing for ${provider}/${modelId}.`);
          }
          return prepared;
        }
      : undefined;
  const authController = createEmbeddedRunAuthController({
    config: params.config,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
    authStore: attemptAuthProfileStore,
    authStorage,
    profileCandidates,
    lockedProfileId,
    initialThinkLevel,
    attemptedThinking,
    fallbackConfigured: input.fallbackConfigured,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe === true,
    authProfileFailurePolicy: params.authProfileFailurePolicy,
    authProfileStateMode: params.authProfileStateMode,
    runId: params.runId,
    provider,
    modelId,
    state: authState,
    ...(prepareModelForAuthProfile ? { prepareModelForAuthProfile } : {}),
    log,
  });
  authStages?.mark("controller");
  const admitAuthProfile = createEmbeddedAuthProfileAdmission({
    authStore: attemptAuthProfileStore,
    profileCandidates,
    lockedProfileId,
    modelId,
    provider,
    log,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe === true,
  });
  const advancePluginHarnessAuthAttempt = async (): Promise<boolean> => {
    if (!pluginHarnessOwnsTransport) {
      return false;
    }
    let nextIndex = authState.profileIndex + 1;
    while (nextIndex < preparedAuthAttempts.length) {
      const candidateIndex = nextIndex++;
      const candidateAttempt = preparedAuthAttempts[candidateIndex];
      // Harness-owned auth shares the controller's run-local exhaustion invariant.
      authState.profileIndex = candidateIndex;
      if (!candidateAttempt) {
        continue;
      }
      const candidate = candidateAttempt.profileId;
      if (!admitAuthProfile(candidate)) {
        continue;
      }
      if (
        !canRunPreparedAgentRuntimeAuthAttempt({
          attempt: candidateAttempt,
          priorProfileAttempted: preparedProfileAttempted,
        })
      ) {
        authState.profileIndex = preparedAuthAttempts.length;
        return false;
      }
      if (candidateAttempt.plan.modelRoute?.authRequirement === "api-key") {
        try {
          await authController.applyAuthProfileCandidate(candidate, candidateIndex);
        } catch {
          continue;
        }
      } else {
        if (!candidate || candidateAttempt.plan.forwardedAuthProfileId !== candidate) {
          continue;
        }
        const prepared = await prepareAuthAttempt(candidateAttempt);
        authController.stopRuntimeAuthRefreshTimer();
        authState.apiKeyInfo = null;
        authState.runtimeAuthState = null;
        prepared.commit();
        authState.lastProfileId = candidate;
      }
      authState.thinkLevel = initialThinkLevel;
      attemptedThinking.clear();
      return true;
    }
    authState.profileIndex = preparedAuthAttempts.length;
    return false;
  };
  const advanceAttemptAuthProfile = pluginHarnessOwnsAuthBootstrap
    ? advancePluginHarnessAuthAttempt
    : authController.advanceAuthProfile;

  if (!pluginHarnessOwnsTransport || pluginHarnessNeedsOpenClawAuthBootstrap) {
    await authController.initializeAuthProfile();
  } else if (forwardedPluginHarnessProfileId) {
    const initialAttempt = preparedAuthAttempts[authState.profileIndex];
    if (
      !admitAuthProfile(initialAttempt?.kind === "profile" ? initialAttempt.profileId : undefined)
    ) {
      if (!(await advancePluginHarnessAuthAttempt())) {
        throw new Error(
          `Prepared auth profiles are temporarily unavailable for ${provider}/${modelId}.`,
        );
      }
    } else {
      preparedProfileAttempted = initialAttempt?.kind === "profile";
      authState.lastProfileId = forwardedPluginHarnessProfileId;
    }
  }
  authStages?.mark("initialize");
  if (authStages) {
    log.trace(
      formatEmbeddedRunStageSummary(
        `[trace:embedded-run] auth stages: runId=${params.runId} sessionId=${params.sessionId} phase=auth`,
        authStages.snapshot(),
      ),
    );
  }
  input.markStartupStage("auth");
  input.notifyExecutionPhase("auth", { provider, model: modelId });
  const routeFacts = getModelProviderRequestRouteFacts(models.effective);
  const fallbackEndpointClass = routeFacts
    ? undefined
    : resolveProviderEndpoint(models.effective.baseUrl, pluginMetadataSnapshot?.owners)
        .endpointClass;
  const providerOwner =
    routeFacts?.providerOwner ??
    (fallbackEndpointClass &&
    !["default", "invalid", "local", "custom"].includes(fallbackEndpointClass)
      ? fallbackEndpointClass
      : undefined);
  const providerRuntimeHandle = {
    ...resolveProviderRuntimePluginHandle({
      provider,
      providerOwner,
      modelId,
      config: params.config,
      workspaceDir: input.workspaceDir,
      env: process.env,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    }),
    modelId,
    prepared: true as const,
  };

  const admittedRunContext = await resolvePreparedRunAdmission({
    runId: params.runId,
    runtimeKind: pluginHarnessOwnsTransport ? "plugin-harness" : "embedded",
    admittedRunContext: params.admittedRunContext,
    preparedRunAdmission: params.preparedRunAdmission,
  });

  const sourceReplyDeliveryRuntime = readSourceReplyDeliveryRuntime(params);
  if (sourceReplyDeliveryRuntime?.origin === "runtime_default") {
    // Route/auth/transport preparation owns the final harness selection. Publishing
    // an earlier guess can either suppress a valid final or leak a private one.
    const visibleReplies =
      agentHarness.deliveryDefaults?.visibleReplies ??
      agentHarness.deliveryDefaults?.sourceVisibleReplies;
    const mode = visibleReplies === "message_tool" ? "message_tool_only" : "automatic";
    sourceReplyDeliveryRuntime.applyPreparedMode(params, mode);
    params.forceMessageTool = mode === "message_tool_only";
  }
  return {
    admittedRunContext,
    provider,
    modelId,
    requestedModelId,
    expectedHarnessArtifact,
    nativeModelOwned,
    ...(assertNativeModelSelectionCurrent ? { assertNativeModelSelectionCurrent } : {}),
    observedRoutes,
    nativeSessionRuntime,
    model,
    authStorage,
    modelRegistry,
    attemptAuthProfileStore,
    lockedProfileId,
    preferredProfileId,
    profileCandidates,
    profileFailureStore: attemptAuthProfileStore,
    genericCompactionRecoveryAllowed,
    pluginHarnessOwnsAuthBootstrap,
    attemptedThinking,
    advanceAttemptAuthProfile,
    maybeRefreshRuntimeAuthForAuthError: authController.maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer: authController.stopRuntimeAuthRefreshTimer,
    getApiKeyInfo: () => authState.apiKeyInfo,
    setThinkLevel: (next: ThinkLevel) => {
      authState.thinkLevel = next;
    },
    resolveRunAttemptAuthProfileStore: (): AuthProfileStore => {
      if (!pluginHarnessOwnsTransport) {
        return attemptAuthProfileStore;
      }
      const activeProfileIds = activePreparedAuthPlan.modelRoute
        ? [
            activePreparedAuthPlan.forwardedAuthProfileId,
            ...(activePreparedAuthPlan.forwardedAuthProfileCandidateIds ?? []),
          ]
        : [authState.lastProfileId];
      return createScopedAuthProfileStore(
        attemptAuthProfileStore,
        activeProfileIds.filter((profileId): profileId is string => Boolean(profileId)),
      );
    },
    snapshot: () => ({
      agentHarness,
      pluginHarnessOwnsTransport,
      effectiveModel: models.effective,
      modelContextWindow: models.runtime.contextWindow,
      contextTokenBudget: resolvedRuntimeModel.contextTokenBudget,
      authoredContextTokenCap: resolvedRuntimeModel.authoredContextTokenCap,
      contextWindowInfo: resolvedRuntimeModel.contextWindowInfo,
      outerContextTokenMeta: {
        contextTokens: resolvedRuntimeModel.contextTokenBudget,
        contextTokensSource: resolvedRuntimeModel.contextTokensSource,
      },
      activePreparedAuthPlan: authState.apiKeyInfo
        ? {
            ...activePreparedAuthPlan,
            selectedAuthMode: authState.apiKeyInfo.mode,
            selectedAuthFlow: authState.apiKeyInfo.authFlow,
          }
        : activePreparedAuthPlan,
      thinkLevel: authState.thinkLevel,
      apiKeyInfo: authState.apiKeyInfo,
      lastProfileId: authState.lastProfileId,
      runtimeAuthState: authState.runtimeAuthState,
      pluginMetadataSnapshot,
      providerRuntimeHandle,
    }),
  };
}
