import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { resolveSessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { resolveContextEngine } from "../../../context-engine/registry.js";
import { attachModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { createAgentHarnessTaskRuntimeScope } from "../../../tasks/agent-harness-task-runtime-scope.js";
import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import { resolveDelegationCapability } from "../../delegation-capability.js";
import { agentHarnessBuildsOpenClawTools } from "../../harness/tool-surface.js";
import { applyAuthHeaderOverride, applyLocalNoAuthHeaderOverride } from "../../model-auth.js";
import { recordAdmittedModelRoutingDecision } from "../../model-routing-decision.js";
import { captureAgentPluginRuntimeRefresh } from "../../plugin-runtime-refresh.js";
import { resolveReplyExpectation } from "../../reply-completion.js";
import { buildAgentRuntimePlan } from "../../runtime-plan/build.js";
import { resolveSessionPermissionExecMode } from "../../session-permission-exec-mode.js";
import { resolveSessionPlacementSandbox } from "../../session-placement-admission.js";
import { resolveSessionSkillResourceSnapshot } from "../../session-placement-skill-resources.js";
import { createToolTerminalObserver } from "../../tool-terminal-outcome.js";
import {
  resolveAttemptWorkspaceSandbox,
  resolveHarnessWorkspace,
} from "../../workspace-sandbox.js";
import type { EmbeddedRunReplayState } from "../replay-state.js";
import { remapSkillReferencePaths } from "../sandbox-skills.js";
import { prepareEmbeddedSkills } from "../skill-runtime.js";
import { mapThinkingLevelForProvider } from "../utils.js";
import { prepareExecApprovalContinuationForAttempt } from "./attempt-exec-approval-continuation.js";
import { withPreparedEmbeddedGatewayTools } from "./attempt-gateway-tools.js";
import { applyResolvedToolPromptFinalizer } from "./attempt-prompt-support.js";
import { EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE } from "./attempt-stage-timing.js";
import { prepareAttemptSystemPromptAdditions } from "./attempt-system-prompt-additions.js";
import { resolveAttemptDispatchApiKey } from "./auth-store.js";
import { runEmbeddedAttemptWithBackend } from "./backend.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { resolveEmbeddedAttemptBasePrompt } from "./helpers.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import { CODEX_HARNESS_ID, resolveAttemptTrajectoryAttribution } from "./runtime-resolution.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import { MAX_BEFORE_AGENT_FINALIZE_REVISIONS } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
type ContextEngine = Awaited<ReturnType<typeof resolveContextEngine>>;
type SessionPromptState = Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
type TerminalRetryState = ReturnType<typeof createEmbeddedRunTerminalRetryState>;

export async function prepareAndDispatchEmbeddedRunAttempt(input: {
  runInput: PreparedEmbeddedRunInput;
  preparedRuntime: PreparedRuntime;
  contextEngine: ContextEngine;
  sessionPromptState: SessionPromptState;
  terminalRetryState: TerminalRetryState;
  replayState: EmbeddedRunReplayState;
  provider: string;
  modelId: string;
  startupStagesEmitted: boolean;
  bootstrapPromptWarningSignaturesSeen: string[];
  resolveRuntimeFallbackReason: () => string | null;
  observeToolOutcome: ToolOutcomeObserver;
  isTurnTainted: () => boolean;
  allocateToolOutcomeOrdinal: NonNullable<EmbeddedRunAttemptParams["allocateToolOutcomeOrdinal"]>;
  getPostCompactionAbortError: () => Error | undefined;
  setPostCompactionAbortController: (controller: AbortController | undefined) => void;
  clearPostCompactionAbortController: (controller: AbortController) => void;
  permissionChange?: EmbeddedRunAttemptParams["permissionChange"];
}) {
  const {
    runInput,
    preparedRuntime,
    contextEngine,
    sessionPromptState,
    terminalRetryState,
    provider,
    modelId,
  } = input;
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
    notifyAgentEvent,
    notifyExecutionPhase,
    notifyRunProgress,
    notifyToolResult,
    resolveAttemptFastModeParam,
  } = runInput.progressController;
  const { createAttemptControls } = runInput.laneController;
  const {
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
  const reusableSessionTarget =
    existingSessionTarget?.sessionKey === resolvedSessionKey ||
    sessionPromptState.sessionTargetAdopted
      ? existingSessionTarget
      : undefined;
  const resolvedTranscriptTarget =
    reusableSessionTarget ??
    (resolvedSessionKey
      ? await resolveSessionTranscriptRuntimeTarget({
          agentId: workspaceResolution.agentId,
          sessionId: sessionPromptState.sessionId,
          sessionKey: resolvedSessionKey,
          storePath: resolveSessionStorePathCore(params.config?.session?.store, {
            agentId: workspaceResolution.agentId,
          }),
        })
      : undefined);
  const resolvedSessionTarget =
    resolvedTranscriptTarget || sessionPromptState.sessionTarget
      ? {
          ...sessionPromptState.sessionTarget,
          ...resolvedTranscriptTarget,
          ...sessionPromptState.sessionWriterFence,
        }
      : undefined;
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
    metadataSnapshot: runtime.pluginMetadataSnapshot,
    providerRuntimeHandle: runtime.providerRuntimeHandle,
    config: params.config,
    workspaceDir,
    agentDir,
    agentId: workspaceResolution.agentId,
    thinkingLevel: mapThinkingLevelForProvider(runtime.thinkLevel, effectiveModel),
    extraParamsOverride: { ...params.streamParams, fastMode: attemptFastMode },
  });
  const trajectoryAttribution = resolveAttemptTrajectoryAttribution({
    model: effectiveModel,
    modelId,
    provider,
    runtimePlan,
  });
  const trajectoryRecorder =
    runtime.agentHarness.id === CODEX_HARNESS_ID &&
    !params.disableTrajectory &&
    params.sessionPersistence !== "detached"
      ? createTrajectoryRuntimeRecorder({
          cfg: params.config,
          env: process.env,
          runId: params.runId,
          sessionId: sessionPromptState.sessionId,
          sessionKey: resolvedSessionKey,
          sessionFile: trajectorySessionFile,
          ...(resolvedSessionTarget?.agentId &&
          resolvedSessionTarget.sessionId &&
          resolvedSessionTarget.sessionKey &&
          resolvedSessionTarget.storePath
            ? {
                sessionTarget: {
                  agentId: resolvedSessionTarget.agentId,
                  sessionId: resolvedSessionTarget.sessionId,
                  sessionKey: resolvedSessionTarget.sessionKey,
                  storePath: resolvedSessionTarget.storePath,
                },
              }
            : {}),
          provider: trajectoryAttribution.provider,
          modelId: trajectoryAttribution.modelId,
          modelApi: trajectoryAttribution.modelApi,
          workspaceDir,
        })
      : undefined;
  let startupStagesEmitted = input.startupStagesEmitted;
  if (!startupStagesEmitted) {
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan);
    startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
    notifyExecutionPhase("attempt_dispatch", { provider, model: modelId });
    emitStartupStageSummary(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
    startupStagesEmitted = true;
  }
  const fallbackReason = input.resolveRuntimeFallbackReason();
  recordAdmittedModelRoutingDecision({
    admittedRunContext: params.admittedRunContext,
    abortSignal: params.abortSignal,
    requestedProvider: params.modelRoutingProvenance?.requestedProvider ?? runInput.provider,
    requestedModel:
      params.modelRoutingProvenance?.requestedModel ?? requestedModelId ?? runInput.modelId,
    selectedProvider: provider,
    selectedModel: modelId,
    selectionMode:
      runtime.lastProfileId && runtime.lastProfileId === lockedProfileId ? "explicit" : "automatic",
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
  const fallbackActive = modelId !== requestedModelId || Boolean(fallbackReason);
  const attemptContextEngine = nativeModelOwned ? undefined : contextEngine;
  const authProfileIdSource =
    runtime.lastProfileId && runtime.lastProfileId === lockedProfileId ? "user" : "auto";
  const attemptAbortController = new AbortController();
  input.setPostCompactionAbortController(attemptAbortController);
  const preparedExecApprovalContinuation = prepareExecApprovalContinuationForAttempt({
    prompt,
    transcriptPrompt: params.transcriptPrompt,
    promptRange: params.execApprovalContinuationPromptRange,
    transcriptPromptRange: params.execApprovalContinuationTranscriptPromptRange,
    contextTokenBudget: runtime.contextTokenBudget,
    modelContextWindow: effectiveModel.contextWindow,
    modelMaxTokens: effectiveModel.maxTokens,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
  });
  if (!params.admittedRunContext) {
    throw new Error("embedded attempt reached dispatch without an admitted run context");
  }
  const admittedRunContext = params.admittedRunContext;
  const assertActiveRun = resolveAdmittedRunActiveAssertion(
    admittedRunContext,
    attemptAbortController.signal,
  );
  if (!assertActiveRun) {
    throw new Error("embedded attempt reached dispatch without an active admitted run");
  }
  assertActiveRun();
  const placementSandbox = runtime.pluginHarnessOwnsTransport
    ? await resolveSessionPlacementSandbox({
        agentId: workspaceResolution.agentId,
        config: params.config,
        sessionId,
        sessionKey: resolvedSessionKey,
        workspaceDir,
      })
    : null;
  assertActiveRun();
  const pluginWorkspace = runtime.pluginHarnessOwnsTransport
    ? await resolveAttemptWorkspaceSandbox({
        ...params,
        agentId: workspaceResolution.agentId,
        cwd: undefined,
        sessionId,
        sessionKey: resolvedSessionKey,
        workspaceDir,
        placementSandbox,
      })
    : undefined;
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
  const pluginSandbox = placementSandbox ?? pluginWorkspace?.sandbox;
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
  let skillsSnapshot = resolveSessionSkillResourceSnapshot(params.skillsSnapshot);
  let skillReferencePaths = pluginSandbox?.readOnlyResourceMounts?.map((mount) => ({
    skillFile: path.join(mount.hostPath, "SKILL.md"),
    readPath: path.posix.join(mount.containerPath, "SKILL.md"),
  }));
  if (pluginSandbox?.enabled && !pluginSandbox.readOnlyResourceMounts?.length && skillsSnapshot) {
    const prepared = await prepareEmbeddedSkills({
      assertCurrent: () => {
        attemptAbortController.signal.throwIfAborted();
        assertActiveRun();
      },
      applySkillEnvironment: false,
      includeCodeModeSkills: false,
      attempt: {
        bootstrapWorkspaceDir,
        config: params.config,
        contextTokenBudget: runtime.contextTokenBudget,
        skillsSnapshot,
        toolExecutionAllow: params.toolExecutionAllow,
      },
      effectiveWorkspace: workspaceDir,
      sandbox: pluginSandbox,
      sessionAgentId: workspaceResolution.agentId,
    });
    skillsSnapshot = {
      ...(prepared.skillsSnapshotForRun ?? skillsSnapshot),
      prompt: prepared.skillsPrompt,
    };
    skillReferencePaths = prepared.skillUsagePaths;
  }
  const attemptControls = createAttemptControls({
    admittedRunContext,
    abortSignal: attemptAbortController.signal,
    onAbort: () => {
      if (!params.abortSignal?.aborted) {
        params.replyOperation?.abortByUser();
      }
    },
  });
  const pluginRefresh = captureAgentPluginRuntimeRefresh();
  const attemptParams: EmbeddedRunAttemptInternalParams & {
    agentId: string;
    sessionKey: string;
    agentHarnessId: string;
  } = {
    providerReviewAcknowledgment: params.providerReviewAcknowledgment,
    pluginRuntimeRefreshPending: pluginRefresh.isPending,
    registerPluginRuntimeRefreshConsumer: (isCurrent) => {
      if (attemptControls.isCurrent()) {
        pluginRefresh.bindConsumer(() => attemptControls.isCurrent() && isCurrent());
      }
    },
    pluginRuntimeRefreshMessages: params.pluginRuntimeRefreshMessages,
    permissionChange: input.permissionChange,
    admittedRunContext: params.admittedRunContext,
    startedAtMs: runInput.startedAtMs,
    contextEngineAgentId: runInput.contextEngineAgentId,
    ...(runtime.pluginHarnessOwnsTransport ? { sandbox: pluginSandbox } : {}),
    operation: "attempt",
    sessionId,
    sessionKey: resolvedSessionKey,
    conversationRecall: params.conversationRecall,
    promptCacheKey: params.promptCacheKey,
    sandboxSessionKey: params.sandboxSessionKey,
    sandboxAgentId: params.sandboxAgentId,
    trigger: params.trigger,
    terminalReplyExpectation: resolveReplyExpectation(params),
    memoryFlushWritePath: params.memoryFlushWritePath,
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
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    isCanonicalWorkspace,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    approvalReviewerDeviceId: params.approvalReviewerDeviceId,
    currentChannelId: params.currentChannelId,
    chatId: params.chatId,
    channelContext: params.channelContext,
    currentMessagingTarget: params.currentMessagingTarget,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    currentInboundAudio: params.currentInboundAudio,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    sessionFile,
    ...(sessionManager ? { sessionManager } : { sessionTarget: resolvedSessionTarget }),
    trajectoryRecorder: trajectoryRecorder ?? undefined,
    ...resolveHarnessWorkspace(workspaceDir, params, pluginWorkspace, pluginSandbox),
    bootstrapWorkspaceDir,
    permissionMode: params.permissionMode,
    requireWorkspaceOnly: params.requireWorkspaceOnly,
    requireWritableSandbox: params.requireWritableSandbox,
    agentDir,
    preparedModelRuntime: runInput.preparedModelRuntime,
    config: params.config,
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
    explicitSkillSelections: params.explicitSkillSelections?.map((selection) => ({
      ...selection,
      path: remapSkillReferencePaths(selection.path, skillReferencePaths),
    })),
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
    delegationCapability: resolveDelegationCapability({
      fallbackActive,
      inputProvenance: params.inputProvenance,
      disableTools: params.disableTools,
      toolsAllow: params.toolsAllow,
    }),
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
          agentHarnessTaskRuntimeScope: createAgentHarnessTaskRuntimeScope({
            requesterSessionKey: params.sessionKey,
            gatewayContextResolver: getGatewayContextResolver(params.admittedRunContext),
          }),
        }
      : {}),
    runtimePlan,
    observeToolTerminal: createToolTerminalObserver(params.runId),
    model: applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(effectiveModel, runtime.apiKeyInfo),
      runtime.runtimeAuthState !== null ? null : runtime.apiKeyInfo,
      params.config,
    ),
    resolvedApiKey: resolvedAttemptApiKey,
    authProfileId: runtime.lastProfileId,
    authProfileIdSource,
    initialReplayState: input.replayState,
    authStorage,
    authProfileStore,
    toolAuthProfileStore,
    modelRegistry,
    agentId: workspaceResolution.agentId,
    thinkLevel: runtime.thinkLevel,
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
    onToolResult: notifyToolResult,
    onAgentToolResult: params.onAgentToolResult,
    onAgentEvent: notifyAgentEvent,
    // Normalize the shipped harness alias once; attempt internals consume only the canonical flag.
    deferTerminalLifecycle: params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd,
    onDeferredLifecycleOwner: params.onDeferredLifecycleOwner,
    onDeferredLifecycleAbort: params.onDeferredLifecycleAbort,
    onExecutionPhase: params.onExecutionPhase,
    extraSystemPrompt,
    gitCoauthorPrompt,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
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
    skillWorkshopAutonomousCapture: params.skillWorkshopAutonomousCapture,
    skillWorkshopUpdateProposals: params.skillWorkshopUpdateProposals,
    skillWorkshopProposalOnly: params.skillWorkshopProposalOnly,
    skillWorkshopProposalEnv: params.skillWorkshopProposalEnv,
    skillWorkshopOrigin: params.skillWorkshopOrigin,
    skillWorkshopProposalMutationBudget: params.skillWorkshopProposalMutationBudget,
    skillWorkshopProposalRevision: params.skillWorkshopProposalRevision,
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
    enableHeartbeatTool: params.enableHeartbeatTool,
    forceHeartbeatTool: params.forceHeartbeatTool,
    requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    internalEvents: params.internalEvents,
    runtimeContextFragments: params.runtimeContextFragments,
    bootstrapPromptWarningSignaturesSeen: input.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature:
      input.bootstrapPromptWarningSignaturesSeen[
        input.bootstrapPromptWarningSignaturesSeen.length - 1
      ],
    suppressNextUserMessagePersistence,
    beforeAgentFinalizeRevisionAttempts,
    maxBeforeAgentFinalizeRevisions: MAX_BEFORE_AGENT_FINALIZE_REVISIONS,
    suppressTranscriptOnlyAssistantPersistence: params.suppressTranscriptOnlyAssistantPersistence,
    assistantErrorTranscript: params.assistantErrorTranscript,
    onUserMessagePersisted: sessionPromptState.onUserMessagePersisted,
    onUserMessagePersistenceInvalidated: () => {
      sessionPromptState.activePrompt.persisted = false;
    },
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
  };
  const rawAttempt = await withPreparedEmbeddedGatewayTools(
    attemptParams,
    attemptControls.isCurrent,
    () => runEmbeddedAttemptWithBackend(attemptParams, nativeSessionRuntime, params.media),
  )
    .catch((err: unknown): never => {
      throw input.getPostCompactionAbortError() ?? err;
    })
    .finally(() => {
      attemptControls.close();
      input.clearPostCompactionAbortController(attemptAbortController);
    });

  const postCompactionAbortError = input.getPostCompactionAbortError();
  if (postCompactionAbortError) {
    throw postCompactionAbortError;
  }
  return {
    dispatchedAttempt: { rawAttempt, preparedAttempt: attemptParams },
    runtimePlan,
    startupStagesEmitted,
  };
}
