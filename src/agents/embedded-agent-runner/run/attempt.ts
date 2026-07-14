/**
 * Orchestrates one embedded-agent attempt from prompt setup through stream result.
 */
import {
  assertContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import { materializeBundleMcpToolsForRun } from "../../agent-bundle-mcp-tools.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../../agent-scope.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import {
  clearToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import type { NormalizedUsage } from "../../usage.js";
import { log } from "../logger.js";
import type { PromptCacheBreak, PromptCacheChange } from "../prompt-cache-observability.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import {
  createEmbeddedAttemptExternalAbortController,
  type EmbeddedAttemptAbortStatePort,
} from "./attempt-abort.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import { completeEmbeddedAttemptResult } from "./attempt-result.js";
import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-cleanup.js";
import { prepareEmbeddedAttemptSessionLock } from "./attempt-session-lock-prepare.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";
import {
  prepareEmbeddedAttemptSkills,
  startEmbeddedAttemptDiagnostics,
  type EmitDiagnosticRunCompleted,
} from "./attempt-startup.js";
import { finalizeEmbeddedAttemptStreamPhase } from "./attempt-stream-finalize.js";
import { prepareEmbeddedAttemptStreamRuntime } from "./attempt-stream-runtime-prepare.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-base-prepare.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { EmbeddedAttemptSessionFileOwner } from "./attempt.session-lock.js";
import {
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
} from "./attempt.sessions-yield.js";
import { clearToolActivityRun } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

export async function runEmbeddedAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const runAbortController = new AbortController();
  const {
    agentCoreThinkingLevel,
    effectiveCwd,
    effectiveFsWorkspaceOnly,
    effectiveWorkspace,
    emitCorePluginToolStageSummary,
    emitPrepStageSummary,
    getCurrentAttemptPluginMetadataSnapshot,
    getProviderRuntimeHandle,
    prepStages,
    proactiveSubagentOrchestration,
    providerThinkingLevel,
    resolvedWorkspace,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  } = await prepareEmbeddedAttemptSetup(params);

  let restoreSkillEnv: (() => void) | undefined;
  let aborted = Boolean(params.abortSignal?.aborted);
  let externalAbort = false;
  let timedOut = false;
  let idleTimedOut = false;
  let timedOutDuringCompaction = false;
  let timedOutDuringToolExecution = false;
  let timedOutByRunBudget = false;
  let promptError: unknown = null;
  let emitDiagnosticRunCompleted: EmitDiagnosticRunCompleted | undefined;
  let beforeAgentRunBlocked = false;
  let beforeAgentRunBlockedBy: string | undefined;
  // Releases the eager session lock if post-prompt code exits before cleanup.
  let releaseRetainedSessionLock: (() => Promise<void>) | undefined;
  let retainedSessionFileOwner: EmbeddedAttemptSessionFileOwner | undefined;
  let bundleMcpRuntime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  let toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  let toolSearchCatalogApplied = false;
  const sessionCleanupOwnsEmbeddedResources = false;
  const cleanupEmbeddedPrepResourcesAfterEarlyExit = async () => {
    if (toolSearchCatalogApplied) {
      clearToolSearchCatalog({
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        agentId: sessionAgentId,
        runId: params.runId,
        catalogRef: toolSearchCatalogRef,
      });
      toolSearchCatalogApplied = false;
    }
    try {
      await bundleMcpRuntime?.dispose();
    } catch {
      /* best-effort */
    } finally {
      bundleMcpRuntime = undefined;
    }
    try {
      await bundleLspRuntime?.dispose();
    } catch {
      /* best-effort */
    } finally {
      bundleLspRuntime = undefined;
    }
  };
  const abortState: EmbeddedAttemptAbortStatePort = {
    markAborted: () => {
      aborted = true;
    },
    markExternalAbort: () => {
      externalAbort = true;
    },
    markTimedOut: () => {
      timedOut = true;
    },
    markTimedOutDuringCompaction: () => {
      timedOutDuringCompaction = true;
    },
    markTimedOutDuringToolExecution: () => {
      timedOutDuringToolExecution = true;
    },
    readTimedOutDuringCompaction: () => timedOutDuringCompaction,
    setPromptError: (error) => {
      promptError = error;
    },
  };
  const externalAbortController = createEmbeddedAttemptExternalAbortController({
    abortSignal: params.abortSignal,
    cleanupAfterEarlyAbort: cleanupEmbeddedPrepResourcesAfterEarlyExit,
    runAbortController,
    runId: params.runId,
    state: abortState,
  });
  try {
    const preparedSkills = prepareEmbeddedAttemptSkills({
      attempt: params,
      effectiveWorkspace,
      sandbox,
      sessionAgentId,
    });
    restoreSkillEnv = preparedSkills.restoreSkillEnv;
    const { skillUsagePaths, skillsPrompt, skillsSnapshotForRun } = preparedSkills;
    prepStages.mark("skills");

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const isRawModelRun = params.modelRun === true || params.promptMode === "none";
    if (isRawModelRun && log.isEnabled("debug")) {
      log.debug(
        `raw model run enabled: modelRun=${params.modelRun === true} promptMode=${params.promptMode ?? "unset"}`,
      );
    }
    const activeContextEngine = isRawModelRun ? undefined : params.contextEngine;
    if (activeContextEngine && activeContextEngine.info.id !== "legacy") {
      assertContextEngineHostSupport({
        contextEngine: activeContextEngine,
        operation: "agent-run",
        host: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      });
    }
    const resolveActiveContextEnginePluginId = () =>
      resolveContextEngineOwnerPluginId(activeContextEngine);
    const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId);
    const { diagnosticTrace, runTrace, emitCompleted } = startEmbeddedAttemptDiagnostics(params);
    emitDiagnosticRunCompleted = emitCompleted;
    const corePluginToolStages = createEmbeddedRunStageTracker();
    let toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor | undefined;
    const preparedToolBase = prepareEmbeddedAttemptToolBase({
      agentDir,
      attempt: params,
      effectiveCwd,
      effectiveWorkspace,
      markCoreToolStage: (name) => corePluginToolStages.mark(name),
      onYield: (message) => {
        yieldDetected = true;
        yieldMessage = message;
        queueYieldInterruptForSession?.();
        runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
        abortSessionForYield?.();
      },
      resolvedWorkspace,
      runAbortController,
      runTrace,
      sandbox,
      sandboxSessionKey,
      sessionAgentId,
      skillUsagePaths,
      skillsSnapshot: skillsSnapshotForRun,
      toolSearchCatalogExecutor: (toolParams) => {
        if (!toolSearchCatalogExecutor) {
          throw new Error("Tool Search catalog executor is unavailable for this run.");
        }
        return toolSearchCatalogExecutor(toolParams);
      },
    });
    toolSearchCatalogRef = preparedToolBase.toolSearchCatalogRef;
    const {
      codeModeControlsEnabledForRun,
      computerContextEpoch,
      localModelLeanEnabled,
      replaySafetyOptions,
      toolSearchRuntimeConfig,
      toolSearchTargetTranscriptProjections,
      toolsEnabled,
      toolsRaw,
    } = preparedToolBase;
    prepStages.mark("core-plugin-tools");
    emitCorePluginToolStageSummary("core-plugin-tools", corePluginToolStages.snapshot());
    const preparedBootstrap = await prepareEmbeddedAttemptBootstrap({
      attempt: params,
      effectiveWorkspace,
      hasReadTool: toolsEnabled && toolsRaw.some((tool) => tool.name === "read"),
      isRawModelRun,
      markStage: (name) => prepStages.mark(name),
      resolvedWorkspace,
      sessionAgentId,
      sessionLabel,
    });
    const { bootstrapPromptWarning, shouldRecordCompletedBootstrapTurn } = preparedBootstrap;

    const { defaultAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // Track sessions_yield tool invocation (callback pattern, like clientToolCallDetected)
    let yieldDetected = false;
    let yieldMessage: string | null = null;
    // Late-binding reference so onYield can abort the session (declared after tool creation)
    let abortSessionForYield: (() => void) | null = null;
    let queueYieldInterruptForSession: (() => void) | null = null;
    let yieldAbortSettled: Promise<void> | null = null;
    const preparedBundleTools = await prepareEmbeddedAttemptBundleTools({
      agentDir,
      attempt: params,
      effectiveWorkspace,
      getCurrentAttemptPluginMetadataSnapshot,
      getProviderRuntimeHandle,
      isRawModelRun,
      preparedToolBase,
      sessionAgentId,
    });
    bundleMcpRuntime = preparedBundleTools.bundleMcpRuntime;
    bundleLspRuntime = preparedBundleTools.bundleLspRuntime;
    const { clientTools, tools, uncompactedEffectiveTools } = preparedBundleTools;
    const preparedToolCatalog = prepareEmbeddedAttemptToolCatalog({
      attempt: params,
      preparedToolBase,
      bundleTools: { clientTools, uncompactedEffectiveTools },
      effectiveCwd,
      effectiveWorkspace,
      sessionAgentId,
      sandboxSessionKey,
      runTrace,
      abortSignal: runAbortController.signal,
      executeCodeModeTool: (toolParams) => {
        if (!toolSearchCatalogExecutor) {
          throw new Error("Code Mode catalog executor is unavailable for this run.");
        }
        return toolSearchCatalogExecutor(toolParams);
      },
      getProviderRuntimeHandle,
      markStage: (name) => prepStages.mark(name),
    });
    const {
      catalogToolHookContext,
      deferredDirectoryToolsCallable,
      effectiveTools,
      emptyExplicitToolAllowlistError,
      toolSearch,
      toolSearchRunPlan,
    } = preparedToolCatalog;
    const replayAllowedToolNames = toolSearchRunPlan.replayAllowedToolNames;
    const liveAllowedToolNames = toolSearchRunPlan.liveAllowedToolNames;
    const capabilityToolNames = toolSearchRunPlan.capabilityToolNames;

    const preparedSystemPrompt = await prepareEmbeddedAttemptSystemPrompt({
      activeContextEngine,
      attempt: params,
      bootstrap: preparedBootstrap,
      capabilityToolNames,
      defaultAgentId,
      deferredDirectoryToolsCallable,
      effectiveCwd,
      effectiveTools,
      effectiveWorkspace,
      getProviderRuntimeHandle,
      isRawModelRun,
      markStage: (name) => prepStages.mark(name),
      proactiveSubagentOrchestration,
      sandbox: sandbox ?? undefined,
      sandboxSessionKey,
      sessionAgentId,
      skillsPrompt,
      toolSearchCatalogRef,
    });
    const { runtimeChannel, runtimeInfo, systemPromptReport } = preparedSystemPrompt;
    const initialSystemPromptText = preparedSystemPrompt.systemPromptText;

    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    const {
      compactionTimeoutMs,
      ownedTranscriptWriteContext,
      sessionLockController,
      withOwnedSessionWriteLock,
    } = await prepareEmbeddedAttemptSessionLock({
      attempt: params,
      externalAbortController,
      getSessionManager: () => sessionManager,
      onSessionFileOwnerAcquired: (owner) => {
        retainedSessionFileOwner = owner;
      },
      onSessionLockReleaseReady: (release) => {
        releaseRetainedSessionLock = release;
      },
    });

    let session: AgentSession | undefined;
    let removeToolResultContextGuard: (() => void) | undefined;
    let trajectoryRecorder: Awaited<
      ReturnType<typeof prepareEmbeddedAttemptSessionRuntime>
    >["trajectoryRecorder"] = null;
    let trajectoryEndRecorded = false;
    let buildAbortSettlePromise: () => Promise<void> | null = () => null;
    let cleanupYieldAborted = false;
    let repairedRejectedThinkingReplay = false;
    try {
      const preparedSessionRuntime = await prepareEmbeddedAttemptSessionRuntime({
        attempt: params,
        ...(activeContextEngine ? { activeContextEngine } : {}),
        agentDir,
        effectiveCwd,
        effectiveWorkspace,
        initialSystemPrompt: initialSystemPromptText,
        isRawModelRun,
        sessionManager: {
          replayAllowedToolNames,
          resolveActiveContextEnginePluginId,
          sessionAgentId,
          sessionLockController,
          withOwnedSessionWriteLock,
        },
        agentSession: {
          agentCoreThinkingLevel,
          clientToolPreparation: {
            catalogToolHookContext,
            clientTools,
            codeModeControlsEnabledForRun,
            deferredDirectoryToolsCallable,
            effectiveTools,
            replaySafetyOptions,
            sandboxEnabled: Boolean(sandbox?.enabled),
            sandboxSessionKey,
            sessionAgentId,
            toolSearchCatalogRef,
            toolSearchRuntimeConfig,
            uncompactedEffectiveTools,
          },
          getCurrentAttemptPluginMetadataSnapshot,
          markStage: (stage) => prepStages.mark(stage),
          runAbortSignal: runAbortController.signal,
        },
        contextGuards: { computerContextEpoch },
        trajectory: {
          effectiveToolCount: effectiveTools.length,
          localModelLeanEnabled,
          ...(systemPromptReport ? { systemPromptReport } : {}),
        },
        transport: {
          abortSignal: runAbortController.signal,
          codeModeControlsEnabled: codeModeControlsEnabledForRun,
          getProviderRuntimeHandle,
          providerThinkingLevel,
          ...(sandbox !== undefined ? { sandbox } : {}),
          sandboxSessionKey,
        },
        externalAbortController,
        lifecycle: {
          onContextGuardsInstalled: (remove) => {
            removeToolResultContextGuard = remove;
          },
          onSessionCreated: (createdSession) => {
            session = createdSession;
          },
          onSessionManagerCreated: (createdSessionManager) => {
            sessionManager = createdSessionManager;
          },
          onSessionSettleTrackerReady: (build) => {
            buildAbortSettlePromise = build;
          },
          onSessionYieldReady: ({ abortActiveSession, activeSession }) => {
            abortSessionForYield = () => {
              yieldAbortSettled = abortActiveSession(SESSIONS_YIELD_ABORT_REASON);
            };
            queueYieldInterruptForSession = () => {
              queueSessionsYieldInterruptMessage(activeSession);
            };
          },
          onTrajectoryRecorderCreated: (recorder) => {
            trajectoryRecorder = recorder;
          },
        },
      });
      const {
        agentSession: {
          activeSession,
          allCustomTools,
          builtinToolNames,
          clientToolCallSlots,
          clientToolLoopDetection,
          hasDeliveredSourceReply,
          hookRunner,
          markSourceReplyDelivered,
          replaySafeToolNames,
          replaySafeTools,
          setActiveSessionSystemPrompt,
          settingsManager,
        },
        anthropicPayloadLogger,
        boundary: sessionBoundary,
        cacheTrace,
        contextGuards,
        isOpenAIResponsesApi,
        preparedUserTurnMessage,
        sessionManager: activeSessionManager,
        sessionPromptState,
        settleTracker: { abortActiveSession, trackPromptSettlePromise },
        state: sessionRuntimeState,
        toolResultPromptProjectionState,
        transcriptPolicy,
        transport: {
          effectiveAgentTransport,
          effectiveExtraParams,
          effectivePromptCacheRetention,
          providerTextTransforms,
          streamStrategy,
        },
      } = preparedSessionRuntime;
      const { boundaryTimezone, includeBoundaryTimestamp, orphanRepair } = sessionBoundary;
      let yieldAborted = false;
      const hookAgentId = sessionAgentId;
      const preparedStreamRuntime = await prepareEmbeddedAttemptStreamRuntime({
        attempt: params,
        activeSession,
        sessionManager: activeSessionManager,
        sessionLockController,
        ownedTranscriptWriteContext,
        runAbortController,
        externalAbortController,
        abortActiveSession,
        abortState,
        trackPromptSettlePromise,
        compactionTimeoutMs,
        guards: {
          sessionAgentId,
          cacheTrace,
          allCustomTools,
          systemPromptText: sessionRuntimeState.systemPromptText,
          transcriptPolicy,
          isOpenAIResponsesApi,
          replayAllowedToolNames,
          liveAllowedToolNames,
          clientToolLoopDetection,
          anthropicPayloadLogger,
          effectiveAgentTransport,
          providerTextTransforms,
          runTrace,
        },
        history: {
          ...(activeContextEngine ? { activeContextEngine } : {}),
          cacheTrace,
          capabilityToolNames,
          effectiveWorkspace,
          isOpenAIResponsesApi,
          isRawModelRun,
          ...(orphanRepair ? { orphanRepair } : {}),
          replayAllowedToolNames,
          sessionAgentId,
          settingsManager,
          systemPromptText: sessionRuntimeState.systemPromptText,
          transcriptPolicy,
          setActiveSessionSystemPrompt,
        },
        stream: {
          runtimeChannel,
          hookRunner,
          hookAgentId,
          diagnosticTrace,
          clientToolCallSlots,
          toolSearchTargetTranscriptProjections,
          isReplaySafeTool: (tool) => replaySafeTools.has(tool as never),
          hasDeliveredSourceReply,
          markSourceReplyDelivered,
          sandboxSessionKey,
          builtinToolNames,
          replaySafeToolNames,
        },
        lifecycle: {
          isYieldDetected: () => yieldDetected,
          markRejectedThinkingReplayRepaired: () => {
            repairedRejectedThinkingReplay = true;
          },
          markStreamReady: () => {
            prepStages.mark("stream-setup");
            emitPrepStageSummary("stream-ready");
          },
          markIdleTimedOut: () => {
            idleTimedOut = true;
          },
          markExternalAbort: () => {
            externalAbort = true;
          },
          markTimedOutDuringCompaction: () => {
            timedOutDuringCompaction = true;
          },
          markTimedOutByRunBudget: () => {
            timedOutByRunBudget = true;
          },
          readRunState: () => ({ aborted, promptError, timedOut, yieldDetected }),
          setToolSearchCatalogExecutor: (executor) => {
            toolSearchCatalogExecutor = executor;
          },
        },
      });
      const {
        abortable,
        cache: {
          observabilityEnabled: cacheObservabilityEnabled,
          promptToolNames: promptCacheToolNames,
        },
        history: {
          contextEnginePromptAuthority,
          contextEngineAssemblySucceeded,
          unwindowedContextEngineMessagesForPrecheck,
        },
        isProbeSession,
        onBlockReplyFlush,
        promptActiveSession,
        stream: preparedStream,
        timeout: attemptTimeout,
      } = preparedStreamRuntime;
      let promptCacheChangesForTurn: PromptCacheChange[] | null = null;
      const {
        subscription,
        queueHandle,
        stopAcceptingSteerMessages,
        getBeforeAgentFinalizeRevisionReason,
      } = preparedStream;
      const { unsubscribe, waitForPendingEvents } = subscription;
      let lastAssistant: AssistantMessage | undefined;
      let currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
      let attemptUsage: NormalizedUsage | undefined;
      let cacheBreak: PromptCacheBreak | null = null;
      let contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
      let finalPromptText: string | undefined;
      const {
        getRunAbortDeadlineAtMs,
        clearTimers: clearAttemptTimeoutTimers,
        removeAbortSignalListener: removeAttemptAbortSignalListener,
      } = attemptTimeout;
      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      let sessionFileUsed: string | undefined = params.sessionFile;

      let preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
      let promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
      try {
        const { promptStartedAt } = await runEmbeddedAttemptPromptPhase({
          attempt: params,
          activeSession,
          sessionManager: activeSessionManager,
          sessionLockController,
          withOwnedSessionWriteLock,
          getCompactionReserveTokens: () => settingsManager.getCompactionReserveTokens(),
          ...(emptyExplicitToolAllowlistError ? { emptyExplicitToolAllowlistError } : {}),
          assembly: {
            hookRunner,
            hookAgentId,
            diagnosticTrace,
            isRawModelRun,
            ...(orphanRepair ? { orphanRepair } : {}),
            sessionAgentId,
            runtimeModel: runtimeInfo.model,
            systemPromptText: sessionRuntimeState.systemPromptText,
            setActiveSessionSystemPrompt,
            cache: {
              observabilityEnabled: cacheObservabilityEnabled,
              retention: effectivePromptCacheRetention,
              streamStrategy,
              transport: effectiveAgentTransport,
              toolNames: promptCacheToolNames,
              trace: cacheTrace,
            },
          },
          context: {
            ...(boundaryTimezone ? { boundaryTimezone } : {}),
            includeBoundaryTimestamp,
            isRawModelRun,
            ...(typeof preparedUserTurnMessage?.timestamp === "number"
              ? { preparedUserTurnTimestamp: preparedUserTurnMessage.timestamp }
              : {}),
            sessionAgentId,
            setActiveSessionSystemPrompt,
            ...(systemPromptReport ? { systemPromptReport } : {}),
            systemPromptText: sessionRuntimeState.systemPromptText,
            toolResultPromptProjectionState,
          },
          execution: {
            effectiveFsWorkspaceOnly,
            effectiveWorkspace,
            sandbox,
          },
          googlePromptCache: {
            extraParams: effectiveExtraParams,
            signal: runAbortController.signal,
          },
          observation: {
            cacheTrace,
            diagnosticTrace,
            effectiveTools,
            hookAgentId,
            hookRunner,
            isRawModelRun,
            runTrace,
            streamStrategy,
            systemPromptText: sessionRuntimeState.systemPromptText,
            toolSearchCompacted: toolSearch.compacted,
            tools,
            trajectoryRecorder,
            transport: effectiveAgentTransport,
            uncompactedEffectiveTools,
          },
          preflight: {
            ...(activeContextEngine ? { activeContextEngine } : {}),
            contextEngineAssemblySucceeded,
            contextEnginePromptAuthority,
            includeBoundaryTimestamp,
            sessionAgentId,
            ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
            ...(unwindowedContextEngineMessagesForPrecheck
              ? { unwindowedContextEngineMessagesForPrecheck }
              : {}),
          },
          submission: {
            promptActiveSession,
            sessionPromptState,
            toolResultPromptProjectionState,
            trajectoryRecorder,
          },
          lifecycle: {
            readState: () => ({
              contextBudgetStatus,
              preflightRecovery,
              promptError,
              promptErrorSource,
            }),
            writeState: (state) => {
              contextBudgetStatus = state.contextBudgetStatus;
              preflightRecovery = state.preflightRecovery;
              promptError = state.promptError;
              promptErrorSource = state.promptErrorSource;
            },
            getPrePromptMessageCount: () => sessionRuntimeState.prePromptMessageCount,
            setPrePromptMessageCount: (count) => {
              sessionRuntimeState.prePromptMessageCount = count;
            },
            setCurrentUserTimestampOverride: (override) => {
              sessionBoundary.setCurrentUserTimestampOverride(override);
            },
            setPromptCacheChangesForTurn: (changes) => {
              promptCacheChangesForTurn = changes;
            },
            setFinalPromptText: (prompt) => {
              finalPromptText = prompt;
            },
            markBeforeAgentRunBlocked: (outcome) => {
              beforeAgentRunBlocked = true;
              beforeAgentRunBlockedBy = outcome.blockedBy;
            },
            markYieldAborted: () => {
              yieldAborted = true;
              cleanupYieldAborted = true;
              aborted = false;
            },
            readYieldState: () => ({ yieldAbortSettled, yieldDetected, yieldMessage }),
            stopAcceptingSteerMessages,
            takePendingMidTurnPrecheckRequest: contextGuards.takePendingMidTurnPrecheckRequest,
          },
        });

        const afterTurn = await finalizeEmbeddedAttemptStreamPhase({
          attempt: params,
          activeSession,
          sessionManager: activeSessionManager,
          sessionLockController,
          withOwnedSessionWriteLock,
          waitForPendingEvents,
          repairedRejectedThinkingReplay,
          getRunAbortDeadlineAtMs,
          shouldFlushForContextEngine: () =>
            Boolean(activeContextEngine && !getBeforeAgentFinalizeRevisionReason()),
          getBeforeAgentFinalizeRevisionReason,
          getContextEngineAfterTurnCheckpoint: contextGuards.getAfterTurnCheckpoint,
          onSettleErrorState: (state) => {
            promptError = state.promptError;
            promptErrorSource = state.promptErrorSource;
          },
          onSettled: (settledStream) => {
            promptError = settledStream.promptError;
            promptErrorSource = settledStream.promptErrorSource;
            timedOutDuringCompaction = settledStream.timedOutDuringCompaction;
            messagesSnapshot = settledStream.messagesSnapshot;
            sessionIdUsed = settledStream.sessionIdUsed;
            lastAssistant = settledStream.lastAssistant;
            currentAttemptAssistant = settledStream.currentAttemptAssistant;
            attemptUsage = settledStream.attemptUsage;
            cacheBreak = settledStream.cacheBreak;
            sessionRuntimeState.promptCache = settledStream.promptCache;
          },
          getState: () => ({
            promptError,
            promptErrorSource,
            yieldAborted,
            sessionIdUsed,
            sessionFileUsed,
          }),
          settle: {
            subscription,
            readLifecycleState: () => ({
              aborted,
              timedOut,
              timedOutDuringCompaction,
            }),
            markTimedOutDuringCompaction: () => {
              timedOutDuringCompaction = true;
            },
            runAbortSignal: runAbortController.signal,
            isProbeSession,
            onBlockReplyFlush,
            abortable,
            prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
            toolSearchTargetTranscriptProjections,
            cache: {
              observabilityEnabled: cacheObservabilityEnabled,
              changesForTurn: promptCacheChangesForTurn,
              retention: effectivePromptCacheRetention,
            },
          },
          afterTurn: {
            activeContextEngine,
            readLifecycleState: () => ({
              aborted,
              timedOut,
              idleTimedOut,
              timedOutDuringCompaction,
            }),
            runtime: {
              effectiveWorkspace,
              agentDir,
              sessionAgentId,
              resolveActiveContextEnginePluginId,
              shouldRecordCompletedBootstrapTurn,
              cacheTrace,
              anthropicPayloadLogger,
              hookAgentId,
              diagnosticTrace,
              skillWorkshopAvailable: uncompactedEffectiveTools.some(
                (tool) => tool.name === "skill_workshop",
              ),
              hookRunner,
              promptStartedAt,
            },
          },
        });
        sessionIdUsed = afterTurn.sessionIdUsed;
        sessionFileUsed = afterTurn.sessionFileUsed;
      } finally {
        clearAttemptTimeoutTimers();
        if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
          log.debug(
            `run cleanup: runId=${params.runId} sessionId=${params.sessionId} aborted=${aborted} timedOut=${timedOut}`,
          );
        }
        try {
          unsubscribe();
        } catch (err) {
          // unsubscribe() should never throw; if it does, it indicates a serious bug.
          // Log at error level to ensure visibility, but don't rethrow in finally block
          // as it would mask any exception from the try block above.
          log.error(
            `CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(err)}`,
          );
        }
        if (params.replyOperation) {
          params.replyOperation.detachBackend(queueHandle);
        }
        clearActiveEmbeddedRun(
          params.sessionId,
          queueHandle,
          params.sessionKey,
          params.sessionFile,
        );
        removeAttemptAbortSignalListener();
      }

      const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
      const finalizedResult = completeEmbeddedAttemptResult({
        attempt: params,
        subscription,
        state: {
          aborted,
          externalAbort,
          timedOut,
          idleTimedOut,
          timedOutDuringCompaction,
          timedOutDuringToolExecution,
          timedOutByRunBudget,
          promptError,
          promptErrorSource,
          preflightRecovery,
          sessionIdUsed,
          sessionFileUsed,
          diagnosticTrace,
          systemPromptReport,
          finalPromptText,
          messagesSnapshot,
          ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
          lastAssistant,
          currentAttemptAssistant,
          attemptUsage,
          promptCache: sessionRuntimeState.promptCache,
          contextBudgetStatus,
          yieldDetected,
          didDeliverSourceReplyViaMessageTool: hasDeliveredSourceReply(),
        },
        clientToolCallSlots,
        hookRunner,
        hookAgentId,
        bootstrapPromptWarning,
        cache: {
          observabilityEnabled: cacheObservabilityEnabled,
          trace: cacheTrace,
          break: cacheBreak,
          changesForTurn: promptCacheChangesForTurn,
          streamStrategy,
        },
        trajectoryRecorder,
      });
      trajectoryEndRecorded = true;
      return finalizedResult;
    } finally {
      await cleanupEmbeddedAttemptSessionPhase({
        attempt: params,
        session,
        sessionManager,
        sessionLockController,
        bundleMcpRuntime,
        bundleLspRuntime,
        removeToolResultContextGuard,
        toolSearchCatalogRef,
        sandboxSessionKey,
        sessionAgentId,
        buildAbortSettlePromise,
        trajectoryRecorder,
        trajectoryEndRecorded,
        cleanupYieldAborted,
        emitDiagnosticRunCompleted,
        readState: () => ({
          aborted,
          externalAbort,
          timedOut,
          idleTimedOut,
          timedOutDuringCompaction,
          timedOutDuringToolExecution,
          timedOutByRunBudget,
          promptError,
          beforeAgentRunBlocked,
          beforeAgentRunBlockedBy,
        }),
      });
    }
  } finally {
    externalAbortController.dispose();
    clearToolActivityRun(params.runId);
    if (!sessionCleanupOwnsEmbeddedResources) {
      try {
        await cleanupEmbeddedPrepResourcesAfterEarlyExit();
      } catch (cleanupErr) {
        log.warn(
          `failed to clean up embedded prep resources after early attempt exit: runId=${params.runId} ${String(cleanupErr)}`,
        );
      }
    }
    try {
      await releaseRetainedSessionLock?.();
    } catch (releaseErr) {
      log.error(
        `failed to release retained session lock on attempt teardown: runId=${params.runId} ${String(releaseErr)}`,
      );
    }
    retainedSessionFileOwner?.release();
    emitDiagnosticRunCompleted?.(
      aborted ? "aborted" : "error",
      promptError ?? new Error("run exited before diagnostic completion"),
    );
    restoreSkillEnv?.();
  }
}
