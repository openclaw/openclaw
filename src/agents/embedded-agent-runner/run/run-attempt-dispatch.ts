import fs from "node:fs/promises";
import * as sourceTurn from "../../../auto-reply/reply/source-turn-id.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import { attachModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { copyExplicitSkillSelectionFileHost } from "../../../skills/discovery/skill-command-provenance.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { createAgentHarnessCompletionScope } from "../../agent-harness-completion-scope.js";
import { resizeExecApprovalContinuationPrompt } from "../../bash-tools.exec-approval-output.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { prepareDelegationCapability } from "../../delegation-capability.js";
import { agentHarnessBuildsOpenClawTools } from "../../harness/tool-surface.js";
import { applyAuthHeaderOverride, applyLocalNoAuthHeaderOverride } from "../../model-auth.js";
import { recordAdmittedModelRoutingDecision } from "../../model-routing-decision.js";
import { captureAgentPluginRuntimeRefresh } from "../../plugin-runtime-refresh.js";
import { resolveReplyExpectation } from "../../reply-completion.js";
import { buildAgentRuntimePlan } from "../../runtime-plan/build.js";
import { resolveSessionPermissionExecMode } from "../../session-permission-exec-mode.js";
import { resolveLiveToolResultMaxChars } from "../../tool-result-limits.js";
import { createToolTerminalObserver } from "../../tool-terminal-outcome.js";
import { preparePluginHarnessWorkspace, resolveHarnessWorkspace } from "../../workspace-sandbox.js";
import { log } from "../logger.js";
import { remapExplicitSkillSelectionPath, remapSkillReferencePaths } from "../sandbox-skills.js";
import { preparePluginHarnessSkills } from "../skill-runtime.js";
import { mapThinkingLevelForProvider } from "../utils.js";
import { createAttemptContinuationRetryCount } from "./attempt-continuation-retry.js";
import { withPreparedEmbeddedGatewayTools } from "./attempt-gateway-tools.js";
import { resolveEmbeddedAttemptMemoryAudience } from "./attempt-memory-audience.js";
import { applyResolvedToolPromptFinalizer } from "./attempt-prompt-support.js";
import { EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE } from "./attempt-stage-timing.js";
import { prepareAttemptSystemPromptAdditions } from "./attempt-system-prompt-additions.js";
import { flushEmbeddedAttemptTrajectoryRecorder } from "./attempt-trajectory-flush.js";
import { prepareEmbeddedHarnessTrajectory } from "./attempt-trajectory.js";
import { resolveAttemptDispatchSessionTarget } from "./attempt-transcript-helpers.js";
import { resolveAttemptDispatchApiKey } from "./auth-store.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import type { PreparedEmbeddedAttemptDispatchInput } from "./execution-context.js";
import { resolveEmbeddedAttemptBasePrompt } from "./helpers.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";
import { projectEmbeddedMessageContext } from "./shared-run-context.js";
import { MAX_BEFORE_AGENT_FINALIZE_REVISIONS } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/** Prepares the selected runtime and dispatches an attempt under its admitted lifecycle. */
export async function prepareAndDispatchEmbeddedRunAttempt(
  input: PreparedEmbeddedAttemptDispatchInput,
  onSettledTurn?: EmbeddedRunAttemptParams["onSettledTurn"],
) {
  const { runInput, preparedRuntime, contextEngine, sessionPromptState, terminalRetryState } =
    input;
  const params = runInput.runParams;
  const {
    workspaceResolution,
    workspaceDir,
    bootstrapWorkspaceDir,
    isCanonicalWorkspace,
    agentDir,
    resolvedSessionKey,
    resolvedToolResultFormat,
    startupStages,
    emitStartupStageSummary,
    lifecycleGeneration,
  } = runInput;
  const {
    fastModeAutoOnSeconds,
    fastModeAutoProgressState,
    fastModeStartedAtMs,
    maybeAnnounceFastModeAutoOff,
    notifyExecutionPhase,
    notifyRunProgress,
    resolveAttemptFastModeParam,
  } = runInput.progressController;
  const { createAttemptControls } = runInput.laneController;
  const {
    provider,
    modelId,
    requestedModelId,
    expectedHarnessArtifact,
    nativeModelOwned,
    authStorage,
    modelRegistry,
    attemptAuthProfileStore,
    lockedProfileId,
    resolveRunAttemptAuthProfileStore,
  } = preparedRuntime;
  const runtime = preparedRuntime.snapshot();
  const effectiveModel = attachModelProviderRuntimePluginHandle(
    runtime.effectiveModel,
    runtime.providerRuntimeHandle,
  );

  params.assertModelInput?.(effectiveModel);

  await fs.mkdir(workspaceDir, { recursive: true });
  if (!input.startupStagesEmitted) {
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.workspace);
  }
  const prompt =
    sessionPromptState.activePrompt.override ??
    resolveEmbeddedAttemptBasePrompt({ provider, prompt: params.prompt });
  const resolvedAttemptApiKey = resolveAttemptDispatchApiKey({
    apiKeyInfo: runtime.apiKeyInfo,
    runtimeAuthState: runtime.runtimeAuthState,
    pluginHarnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
  });
  const attemptFastMode = resolveAttemptFastModeParam();
  const existingSessionTarget = sessionPromptState.sessionTarget;
  const selectedPromptTarget = { ...existingSessionTarget };
  const resolvedSessionTarget = await resolveAttemptDispatchSessionTarget({
    agentId: workspaceResolution.agentId,
    config: params.config,
    sessionKey: resolvedSessionKey,
    promptState: sessionPromptState,
  });
  await sessionPromptState.settleOwnedTranscriptProjection(
    resolvedSessionTarget,
    params.abortSignal,
  );
  const trajectorySessionFile = resolvedSessionTarget?.sessionKey ?? sessionPromptState.sessionFile;
  if (!input.startupStagesEmitted) {
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.prompt);
  }
  const runtimePlan = buildAgentRuntimePlan({
    provider,
    modelId,
    model: effectiveModel,
    modelApi: effectiveModel.api,
    harnessId: runtime.agentHarness.id,
    harnessRuntime: runtime.agentHarness.id,
    preparedAuthPlan: runtime.activePreparedAuthPlan,
    transportConfig: runtime.transportConfig,
    metadataSnapshot: runtime.pluginMetadataSnapshot,
    providerRuntimeHandle: runtime.providerRuntimeHandle,
    config: params.config,
    workspaceDir,
    agentDir,
    agentId: workspaceResolution.agentId,
    thinkingLevel: mapThinkingLevelForProvider(runtime.thinkLevel, effectiveModel),
    extraParamsOverride: { ...params.streamParams, fastMode: attemptFastMode },
  });
  if (!params.admittedRunContext) {
    throw new Error("embedded attempt reached dispatch without an admitted run context");
  }
  const admittedRunContext = params.admittedRunContext;
  const requireActiveAssertion = (signal?: AbortSignal) => {
    const assertion = resolveAdmittedRunActiveAssertion(admittedRunContext, signal);
    if (!assertion) {
      throw new Error("embedded attempt reached dispatch without an active admitted run");
    }
    return assertion;
  };
  const assertTrajectoryCurrent = requireActiveAssertion(params.abortSignal);
  const trajectoryRecorder = await prepareEmbeddedHarnessTrajectory({
    attempt: params,
    harnessId: runtime.agentHarness.id,
    model: effectiveModel,
    modelId,
    provider,
    runtimePlan,
    sessionId: sessionPromptState.sessionId,
    sessionKey: resolvedSessionKey,
    sessionFile: trajectorySessionFile,
    sessionTarget: resolvedSessionTarget,
    workspaceDir,
  });
  assertTrajectoryCurrent();
  if (!input.startupStagesEmitted) {
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan);
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
    notifyExecutionPhase("attempt_dispatch", { provider, model: modelId });
    emitStartupStageSummary(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
  }
  const fallbackReason = input.resolveRuntimeFallbackReason();
  const explicitAuthProfile = Boolean(
    runtime.lastProfileId && runtime.lastProfileId === lockedProfileId,
  );
  recordAdmittedModelRoutingDecision({
    admittedRunContext: params.admittedRunContext,
    abortSignal: params.abortSignal,
    requestedProvider: params.modelRoutingProvenance?.requestedProvider ?? runInput.provider,
    requestedModel:
      params.modelRoutingProvenance?.requestedModel ?? requestedModelId ?? runInput.modelId,
    selectedProvider: provider,
    selectedModel: modelId,
    selectionMode: explicitAuthProfile ? "explicit" : "automatic",
    credentialProfileId: runtime.lastProfileId,
    fallbackSelected:
      params.modelRoutingProvenance?.stage === "fallback" || Boolean(fallbackReason),
    fallbackReason: params.modelRoutingProvenance?.fallbackReason,
  });
  const { sessionId, sessionFile, suppressNextUserMessagePersistence } = sessionPromptState;
  const skipPreparedUserTurnMessage = sessionPromptState.activePrompt.internal;
  const { sessionManager } = params;
  const { nativeSessionRuntime } = preparedRuntime;
  const authProfileStore = resolveRunAttemptAuthProfileStore();
  const toolAuthProfileStore = agentHarnessBuildsOpenClawTools(runtime.agentHarness.id)
    ? attemptAuthProfileStore
    : undefined;
  const captureRuntimeArtifact = Boolean(params.onSuccessfulAuthBinding || expectedHarnessArtifact);
  const beforeAgentFinalizeRevisionAttempts = terminalRetryState.beforeFinalizeRevisionAttempts;
  const fallbackActive =
    modelId !== requestedModelId ||
    params.modelRoutingProvenance?.stage === "fallback" ||
    Boolean(fallbackReason);
  const attemptContextEngine =
    nativeModelOwned && contextEngine?.info.id === "legacy" ? undefined : contextEngine;
  const preparedExecApprovalContinuation = { prompt, transcriptPrompt: params.transcriptPrompt };
  const promptRange = params.execApprovalContinuationPromptRange;
  if (promptRange) {
    const contextWindowTokens = Math.max(
      1,
      Math.floor(
        runtime.contextTokenBudget ??
          effectiveModel.contextWindow ??
          effectiveModel.maxTokens ??
          DEFAULT_CONTEXT_TOKENS,
      ),
    );
    const maxOutputUtf16Units = resolveLiveToolResultMaxChars({ contextWindowTokens });
    const resize = (outputPrompt: string, range = promptRange) =>
      resizeExecApprovalContinuationPrompt({ prompt: outputPrompt, range, maxOutputUtf16Units });
    preparedExecApprovalContinuation.prompt = resize(prompt);
    preparedExecApprovalContinuation.transcriptPrompt =
      params.transcriptPrompt === undefined
        ? undefined
        : resize(
            params.transcriptPrompt,
            params.execApprovalContinuationTranscriptPromptRange ?? promptRange,
          );
    params.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.(
      preparedExecApprovalContinuation.transcriptPrompt ?? preparedExecApprovalContinuation.prompt,
    );
  }
  const assertActiveRun = requireActiveAssertion(params.abortSignal);
  assertActiveRun();
  if (runtime.pluginHarnessOwnsTransport) {
    await params.awaitSessionDiffBaseline?.();
    assertActiveRun();
  }
  using placement = runtime.pluginHarnessOwnsTransport
    ? await preparePluginHarnessWorkspace({
        ...params,
        agentId: workspaceResolution.agentId,
        cwd: undefined,
        sessionId,
        sessionKey: resolvedSessionKey,
        workspaceDir,
      })
    : null;
  assertActiveRun();
  const pluginWorkspace = placement?.workspace;
  const continuationRetryCount = createAttemptContinuationRetryCount(
    params,
    runtime,
    { sessionId, agentDir },
    assertActiveRun,
  );
  const promptMedia = pluginWorkspace
    ? await prepareEmbeddedAttemptPromptExecution({
        attempt: { ...params, model: effectiveModel },
        mediaOwnerAgentId: pluginWorkspace.sessionAgentId,
        effectiveFsWorkspaceOnly: pluginWorkspace.effectiveFsWorkspaceOnly,
        effectiveWorkspace: pluginWorkspace.effectiveWorkspace,
        prompt: "",
        sandbox: pluginWorkspace.sandbox,
        skipPromptSubmission: false,
        pluginHarness: true,
      })
    : { images: params.images, imageOrder: params.imageOrder, media: params.media };
  // Plugin harnesses own their tool materialization, so the host cannot attest
  // a message tool. Finalize conservatively instead of leaking phantom guidance.
  const pluginHarnessPrompt =
    runtime.pluginHarnessOwnsTransport && params.finalizePromptForResolvedTools
      ? applyResolvedToolPromptFinalizer({
          prompt: preparedExecApprovalContinuation.prompt,
          activeToolNames: [],
          finalize: params.finalizePromptForResolvedTools,
        })
      : undefined;
  const pluginSandbox = placement?.sandbox ?? pluginWorkspace?.sandbox;
  if (params.permissionMode) {
    // Attempts narrow this shared run-owned policy before recovery can reuse it.
    params.execOverrides ??= {};
    params.execOverrides.mode = resolveSessionPermissionExecMode({ mode: params.permissionMode });
  }
  const { extraSystemPrompt, gitCoauthorPrompt } = await prepareAttemptSystemPromptAdditions({
    agentId: workspaceResolution.agentId,
    authProfileId: runtime.lastProfileId,
    config: params.config,
    extraSystemPrompt: params.extraSystemPrompt,
    modelId,
    provider,
    sessionId,
    sessionKey: params.sessionKey,
    storePath: params.sessionTarget?.storePath,
    toolsAllow: params.toolsAllow,
  });
  assertActiveRun();
  const { skillsSnapshot, skillReferencePaths } = await preparePluginHarnessSkills({
    assertCurrent: assertActiveRun,
    attempt: {
      bootstrapWorkspaceDir,
      config: params.config,
      contextTokenBudget: runtime.contextTokenBudget,
      skillsSnapshot: params.skillsSnapshot,
      toolExecutionAllow: params.toolExecutionAllow,
    },
    effectiveWorkspace: workspaceDir,
    sandbox: pluginSandbox,
    sessionAgentId: workspaceResolution.agentId,
  });
  const delegationCapability = await prepareDelegationCapability({
    fallbackActive,
    run: params,
    sessionKey: resolvedSessionKey,
    sessionId,
    modelProvider: provider,
    modelId,
  });
  assertActiveRun();
  // Resolve after the last fallible preparation so the attempt's finally owns the leases.
  const { memoryAudience, release: releaseMemoryAudience } =
    await resolveEmbeddedAttemptMemoryAudience({
      memoryAudience: params.memoryAudience,
      config: params.config,
      agentId: workspaceResolution.agentId,
      sessionKey: resolvedSessionKey,
      sessionId,
      senderIsOwner: params.senderIsOwner,
      admission: runInput.sessionAdmission,
      assertCallerCurrent: assertActiveRun,
    });
  const attemptControls = createAttemptControls({
    admittedRunContext,
    onAbort: () => {
      params.replyOperation?.abortByUser();
    },
  });
  const pluginRefresh = captureAgentPluginRuntimeRefresh();
  const preparedSessionTarget =
    (!sessionManager || params.sessionPersistence === "detached") &&
    resolvedSessionTarget?.agentId &&
    resolvedSessionTarget.sessionId &&
    resolvedSessionTarget.sessionKey &&
    resolvedSessionTarget.storePath
      ? {
          target: captureSessionTranscriptTargetBinding({
            ...resolvedSessionTarget,
            agentId: resolvedSessionTarget.agentId,
            sessionId: resolvedSessionTarget.sessionId,
            sessionKey: resolvedSessionTarget.sessionKey,
            storePath: resolvedSessionTarget.storePath,
          }),
          assertCurrent: () => {
            assertActiveRun();
            if (
              !attemptControls.isCurrent() ||
              sessionPromptState.sessionId !== sessionId ||
              (["agentId", "sessionId", "sessionKey", "storePath", "threadId"] as const).some(
                (field) =>
                  sessionPromptState.sessionTarget?.[field] !== selectedPromptTarget[field],
              )
            ) {
              throw new Error("Session target preparation outlived its attempt");
            }
          },
        }
      : undefined;
  const attemptParams: EmbeddedRunAttemptInternalParams & {
    agentId: string;
    sessionKey: string;
    agentHarnessId: string;
  } = {
    modelCallSequence: (runInput.modelCallSequence ??= { value: 0 }),
    bindWatchdogAttempt: attemptControls.bindWatchdogAttempt,
    providerReviewAcknowledgment: params.providerReviewAcknowledgment,
    awaitSessionDiffBaseline: params.awaitSessionDiffBaseline,
    pluginRuntimeRefreshPending: pluginRefresh.isPending,
    registerPluginRuntimeRefreshConsumer: (isCurrent) => {
      if (attemptControls.isCurrent()) {
        pluginRefresh.bindConsumer(() => attemptControls.isCurrent() && isCurrent());
      }
    },
    pluginRuntimeRefreshMessages: params.pluginRuntimeRefreshMessages,
    continuation: sessionPromptState.continuation,
    runCleanupSettlement: params.runCleanupSettlement,
    executionSelection: params.executionSelection,
    permissionChange: input.permissionChange,
    admittedRunContext: params.admittedRunContext,
    startedAtMs: runInput.startedAtMs,
    contextEngineAgentId: runInput.contextEngineAgentId,
    ...(runtime.pluginHarnessOwnsTransport ? { sandbox: pluginSandbox } : {}),
    operation: "attempt",
    sessionId,
    sessionKey: resolvedSessionKey,
    memoryAudience,
    conversationRecall: params.conversationRecall,
    promptCacheKey: params.promptCacheKey,
    sandboxSessionKey: params.sandboxSessionKey,
    sandboxAgentId: params.sandboxAgentId,
    trigger: params.trigger,
    terminalReplyExpectation: resolveReplyExpectation(params),
    memoryFlushWritePath: params.memoryFlushWritePath,
    memoryFlushTools: params.memoryFlushTools,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    clientCaps: params.clientCaps,
    bootstrapUserProfileId: params.bootstrapUserProfileId,
    gatewayUiCommandTarget: params.gatewayUiCommandTarget,
    pinnedWidgetAuthoring: params.pinnedWidgetAuthoring,
    toolBindings: params.toolBindings,
    chatType: params.chatType,
    agentAccountId: params.agentAccountId,
    conversationRoutePeerId: params.conversationRoutePeerId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    conversationToolPolicy: params.conversationToolPolicy,
    messageActionTurnCapability: params.messageActionTurnCapability,
    onCompletedSourceReplyDelivered: params.onCompletedSourceReplyDelivered,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    isCanonicalWorkspace,
    ...projectEmbeddedMessageContext(params),
    hasRepliedRef: params.hasRepliedRef,
    sessionFile,
    ...(sessionManager ? { sessionManager } : { sessionTarget: resolvedSessionTarget }),
    preparedSessionTarget,
    trajectoryRecorder: trajectoryRecorder ?? undefined,
    ...resolveHarnessWorkspace(workspaceDir, params, pluginWorkspace, pluginSandbox),
    bootstrapWorkspaceDir,
    permissionMode: params.permissionMode,
    requireWorkspaceOnly: params.requireWorkspaceOnly,
    agentDir,
    preparedModelRuntime: runInput.preparedModelRuntime,
    config: params.config,
    transportConfig: runtime.transportConfig,
    toolOverrides: params.toolOverrides,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    ...(attemptContextEngine
      ? {
          contextEngine: attemptContextEngine,
          contextWindowInfo: runtime.contextWindowInfo,
        }
      : {}),
    ...(runtime.contextTokenBudget === undefined
      ? {}
      : { contextTokenBudget: runtime.contextTokenBudget }),
    ...(runtime.modelContextWindow === undefined
      ? {}
      : { modelContextWindow: runtime.modelContextWindow }),
    ...(runtime.authoredContextTokenCap === undefined
      ? {}
      : { authoredContextTokenCap: runtime.authoredContextTokenCap }),
    skillsSnapshot,
    prompt: remapSkillReferencePaths(
      pluginHarnessPrompt ?? preparedExecApprovalContinuation.prompt,
      skillReferencePaths,
    ),
    transcriptPrompt:
      pluginHarnessPrompt !== undefined && params.transcriptPrompt === undefined
        ? preparedExecApprovalContinuation.prompt
        : preparedExecApprovalContinuation.transcriptPrompt,
    finalizePromptForResolvedTools:
      pluginHarnessPrompt === undefined ? params.finalizePromptForResolvedTools : undefined,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    // The outer run-loop owns the begun lease; the inner attempt reports only
    // the accepted candidate boundary to that owner.
    onContextEngineTurnCandidate: params.onContextEngineTurnCandidate,
    skipPreparedUserTurnMessage,
    currentInboundEventKind: params.currentInboundEventKind,
    currentInboundContext: params.currentInboundContext,
    explicitSkillSelections: params.explicitSkillSelections?.map((selection) =>
      copyExplicitSkillSelectionFileHost(selection, {
        ...selection,
        path: remapExplicitSkillSelectionPath(selection, skillReferencePaths),
      }),
    ),
    images: promptMedia.images,
    imageOrder: promptMedia.imageOrder,
    media: promptMedia.media,
    clientTools: params.clientTools,
    disableTools: params.disableTools,
    provider,
    modelId,
    requestedModelId,
    fallbackActive,
    fallbackReason,
    delegationCapability,
    isFinalFallbackAttempt: params.isFinalFallbackAttempt,
    agentHarnessId: runtime.agentHarness.id,
    agentHarnessRuntimeOverride: runtime.agentHarness.id,
    modelSelectionLocked: params.modelSelectionLocked,
    ...(nativeSessionRuntime
      ? {
          expectedSessionRuntimeOwnership: {
            model: "native",
            auth: nativeSessionRuntime.auth,
            ...(nativeSessionRuntime.auth === "host"
              ? { modelRef: nativeSessionRuntime.modelRef }
              : {}),
          },
        }
      : {}),
    ...(captureRuntimeArtifact ? { captureRuntimeArtifact: true } : {}),
    ...(expectedHarnessArtifact?.artifact
      ? { expectedRuntimeArtifact: expectedHarnessArtifact?.artifact }
      : {}),
    ...(params.sessionKey
      ? {
          agentHarnessCompletionScope: createAgentHarnessCompletionScope({
            requesterSessionKey: params.sessionKey,
            requesterAgentId: workspaceResolution.agentId,
            gatewayContextResolver: getGatewayContextResolver(params.admittedRunContext),
          }),
        }
      : {}),
    runtimePlan,
    observeToolTerminal: createToolTerminalObserver(params.runId),
    model: applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(
        effectiveModel,
        runtime.runtimeAuthState ?? runtime.apiKeyInfo,
      ),
      runtime.runtimeAuthState !== null ? null : runtime.apiKeyInfo,
      runtime.transportConfig,
    ),
    resolvedApiKey: resolvedAttemptApiKey,
    authProfileId: runtime.lastProfileId,
    authProfileIdSource: params.authProfileBinding
      ? params.authProfileIdSource
      : explicitAuthProfile
        ? "user"
        : "auto",
    authProfileBinding: params.authProfileBinding,
    initialReplayState: input.replayState,
    authStorage,
    authProfileStore,
    toolAuthProfileStore,
    modelRegistry,
    agentId: workspaceResolution.agentId,
    thinkLevel: runtime.thinkLevel,
    thinkingExplicit: params.thinkingExplicit,
    onToolOutcome: input.observeToolOutcome,
    isTurnTainted: input.isTurnTainted,
    allocateToolOutcomeOrdinal: input.allocateToolOutcomeOrdinal,
    onToolStreamBoundary: maybeAnnounceFastModeAutoOff,
    onRunProgress: notifyRunProgress,
    fastMode: attemptFastMode,
    fastModeAuto: params.fastMode === "auto",
    ...(params.fastMode === "auto"
      ? {
          fastModeStartedAtMs,
          fastModeAutoOnSeconds,
          fastModeAutoProgressState,
        }
      : {}),
    verboseLevel: params.verboseLevel,
    reasoningLevel: params.reasoningLevel,
    toolResultFormat: resolvedToolResultFormat,
    toolProgressDetail: params.toolProgressDetail,
    execSession: params.execSession,
    execOverrides: params.execOverrides,
    bashElevated: params.bashElevated,
    timeoutMs: params.timeoutMs,
    runTimeoutOverrideMs: params.runTimeoutOverrideMs,
    runId: params.runId,
    lifecycleGeneration,
    abortSignal: attemptControls.abortSignal,
    onAttemptDeadlineChanged: attemptControls.onAttemptDeadlineChanged,
    onAttemptTimeout: attemptControls.onAttemptTimeout,
    onAttemptAbort: attemptControls.onAttemptAbort,
    onSettledTurn,
    replyOperation: params.replyOperation,
    shouldEmitToolResult: params.shouldEmitToolResult,
    shouldEmitToolOutput: params.shouldEmitToolOutput,
    onPartialReply: params.onPartialReply,
    onAssistantMessageStart: params.onAssistantMessageStart,
    onBlockReply: params.onBlockReply,
    onBlockReplyFlush: params.onBlockReplyFlush,
    blockReplyBreak: params.blockReplyBreak,
    blockReplyChunking: params.blockReplyChunking,
    onReasoningStream: params.onReasoningStream,
    streamReasoningInNonStreamModes: params.streamReasoningInNonStreamModes,
    onReasoningEnd: params.onReasoningEnd,
    onToolResult: params.onToolResult,
    onAgentToolResult: params.onAgentToolResult,
    onAgentEvent: async (event) => params.onAgentEvent?.(event),
    // Normalize the shipped harness alias once; attempt internals consume only the canonical flag.
    deferTerminalLifecycle: params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd,
    onDeferredLifecycleOwner: params.onDeferredLifecycleOwner,
    onDeferredLifecycleAbort: params.onDeferredLifecycleAbort,
    onExecutionPhase: params.onExecutionPhase,
    extraSystemPrompt,
    gitCoauthorPrompt,
    preparedTtsPreferences: params.preparedTtsPreferences,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    messageToolFinalByDefault: params.messageToolFinalByDefault,
    silentReplyPromptMode: params.silentReplyPromptMode,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    scheduledToolPolicy: params.scheduledToolPolicy,
    runtimePluginToolGrant: params.runtimePluginToolGrant,
    cronCreatorAuthorityCapability: params.cronCreatorAuthorityCapability,
    cronCreatorAuthorityUnavailableReason: params.cronCreatorAuthorityUnavailableReason,
    streamParams: params.streamParams,
    modelRun: params.modelRun,
    disableTrajectory: params.disableTrajectory,
    skillWorkshopReviewOf: params.skillWorkshopReviewOf,
    skillLibraryAuthoring: params.skillLibraryAuthoring,
    promptMode: params.promptMode,
    ownerNumbers: params.ownerNumbers,
    enforceFinalTag: params.enforceFinalTag,
    silentExpected: params.silentExpected,
    suppressLiveStreamOutput: params.suppressLiveStreamOutput,
    bootstrapContextMode: params.bootstrapContextMode,
    bootstrapContextRunKind: params.bootstrapContextRunKind,
    jobId: params.jobId,
    scheduledRuntimeAuthority: params.scheduledRuntimeAuthority,
    scheduledRuntimeAuthorityRecoveryRequired: params.scheduledRuntimeAuthorityRecoveryRequired,
    toolsAllow: params.toolsAllow,
    toolExecutionAllow: params.toolExecutionAllow,
    // Authorized prompt enrichment needs the exact prepared turn policy identity.
    toolAuthorityFingerprint: params.toolAuthorityFingerprint,
    sessionPersistence: params.sessionPersistence,
    // The host loop settles all completed counts, including default/SDK runs.
    compactionCountOwner: "caller",
    onContextAccountingEvent: params.onContextAccountingEvent,
    onCompactionRequestBudget: params.onCompactionRequestBudget,
    ...(params.systemAgentTool ? { systemAgentTool: params.systemAgentTool } : {}),
    cleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,
    oneShotCliRun: params.oneShotCliRun,
    disableMessageTool: params.disableMessageTool,
    swarmCollector: params.swarmCollector,
    swarmOutputSchema: params.swarmOutputSchema,
    forceRestartSafeTools: params.forceRestartSafeTools,
    forceCodeModeTools: params.forceCodeModeTools,
    codeModeOverride: params.codeModeOverride,
    disableToolSearch: params.disableToolSearch,
    sessionReadScopeKey: params.sessionReadScopeKey,
    forceMessageTool: params.forceMessageTool,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    internalEvents: params.internalEvents,
    runtimeContextFragments: params.runtimeContextFragments,
    bootstrapPromptWarningSignaturesSeen: input.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: input.bootstrapPromptWarningSignaturesSeen.at(-1),
    suppressNextUserMessagePersistence,
    beforeAgentFinalizeRevisionAttempts,
    completionCheck: terminalRetryState.completionCheck,
    maxBeforeAgentFinalizeRevisions: MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
    suppressTranscriptOnlyAssistantPersistence: params.suppressTranscriptOnlyAssistantPersistence,
    assistantErrorTranscript: params.assistantErrorTranscript,
    onUserMessagePersisted: sessionPromptState.onUserMessagePersisted,
    onUserMessagePersistenceInvalidated: () => {
      sessionPromptState.activePrompt.persisted = false;
    },
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
    privateCompletion: params.privateCompletion,
    ...continuationRetryCount.capability,
  };
  // Recovery changes execution IDs without changing the original admitted input source.
  sourceTurn.copyChannelSourceTurnContext(attemptParams, params);
  let rawAttempt: EmbeddedRunAttemptResult;
  try {
    rawAttempt = await withPreparedEmbeddedGatewayTools(attemptParams, () => {
      assertActiveRun();
      placement?.assertCurrent();
      return runEmbeddedAttemptWithBackend(attemptParams, nativeSessionRuntime, params.media);
    });
  } catch (err) {
    throw input.getPostCompactionAbortError() ?? err;
  } finally {
    attemptControls.close();
    try {
      if (trajectoryRecorder) {
        // The plugin's revoked host cannot flush during cancellation. The creator
        // still owns settlement of events accepted before that revocation.
        await flushEmbeddedAttemptTrajectoryRecorder({
          runId: params.runId,
          sessionId,
          trajectoryRecorder,
          log,
        });
      }
    } finally {
      releaseMemoryAudience();
    }
  }

  const postCompactionAbortError = input.getPostCompactionAbortError();
  if (postCompactionAbortError) {
    throw postCompactionAbortError;
  }
  if (pluginWorkspace?.sandboxRuntime) {
    rawAttempt.sandboxRuntime = pluginWorkspace.sandboxRuntime;
  }
  continuationRetryCount.applyTo(rawAttempt);
  return {
    dispatchedAttempt: { rawAttempt, preparedAttempt: attemptParams },
    runtimePlan,
    startupStagesEmitted: true,
  };
}
