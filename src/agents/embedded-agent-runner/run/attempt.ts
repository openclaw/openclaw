/**
 * Orchestrates one embedded-agent attempt from prompt setup through stream result.
 */
import {
  bindOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import {
  assertContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
} from "../../../context-engine/host-compat.js";
import { resolveContextEngineOwnerPluginId } from "../../../context-engine/registry.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import { materializeBundleMcpToolsForRun } from "../../agent-bundle-mcp-tools.js";
import { resolveAgentDir, resolveSessionAgentIds } from "../../agent-scope.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { createCacheTrace } from "../../cache-trace.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { releasePendingAgentSteeringItems } from "../../subagent-registry.js";
import {
  clearToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import type { NormalizedUsage } from "../../usage.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { log } from "../logger.js";
import type { PromptCacheBreak, PromptCacheChange } from "../prompt-cache-observability.js";
import { clearActiveEmbeddedRun, type EmbeddedAgentQueueHandle } from "../runs.js";
import { getEmbeddedSessionPromptState } from "../session-prompt-state.js";
import { resolveEmbeddedAgentApiKey } from "../stream-resolution.js";
import { flushPendingToolResultsAfterIdle } from "../wait-for-idle-before-flush.js";
import { abortable as abortableWithSignal } from "./abortable.js";
import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
  type EmbeddedAttemptAbortStatePort,
} from "./attempt-abort.js";
import { runEmbeddedAttemptBeforeAgentRun } from "./attempt-before-agent-run.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-context-guards.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-assembly.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-context.js";
import { dispatchEmbeddedAttemptPrompt } from "./attempt-prompt-dispatch.js";
import { handleEmbeddedAttemptPromptError } from "./attempt-prompt-error.js";
import { handleEmbeddedAttemptMidTurnPrecheck } from "./attempt-prompt-preflight.js";
import { completeEmbeddedAttemptResult } from "./attempt-result.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-boundary.js";
import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-cleanup.js";
import { prepareEmbeddedAttemptSessionLock } from "./attempt-session-lock-prepare.js";
import { prepareEmbeddedAttemptSessionManager } from "./attempt-session-manager-prepare.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./attempt-session-settle.js";
import { prepareEmbeddedAttemptAgentSession } from "./attempt-session.js";
import { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";
import {
  prepareEmbeddedAttemptSkills,
  startEmbeddedAttemptDiagnostics,
  type EmitDiagnosticRunCompleted,
} from "./attempt-startup.js";
import { finalizeEmbeddedAttemptStreamPhase } from "./attempt-stream-finalize.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-transport.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-base-prepare.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import type { EmbeddedAttemptSessionFileOwner } from "./attempt.session-lock.js";
import {
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
} from "./attempt.sessions-yield.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import { PREEMPTIVE_OVERFLOW_ERROR_TEXT } from "./preemptive-compaction.js";
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
    let systemPromptText = preparedSystemPrompt.systemPromptText;

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
    let trajectoryRecorder: Awaited<ReturnType<typeof prepareEmbeddedAttemptTrajectory>> = null;
    let trajectoryEndRecorded = false;
    let buildAbortSettlePromise: () => Promise<void> | null = () => null;
    let cleanupYieldAborted = false;
    let repairedRejectedThinkingReplay = false;
    try {
      const preparedSessionManager = await prepareEmbeddedAttemptSessionManager({
        attempt: params,
        activeContextEngine,
        agentDir,
        effectiveCwd,
        effectiveWorkspace,
        onSessionManagerCreated: (createdSessionManager) => {
          sessionManager = createdSessionManager;
        },
        replayAllowedToolNames,
        resolveActiveContextEnginePluginId,
        sessionAgentId,
        sessionLockController,
        withOwnedSessionWriteLock,
      });
      const { isOpenAIResponsesApi, preparedUserTurnMessage, transcriptPolicy } =
        preparedSessionManager;
      sessionManager = preparedSessionManager.sessionManager;

      const {
        activeSession,
        allCustomTools,
        builtinToolNames,
        clientToolCallSlots,
        clientToolDefs,
        clientToolLoopDetection,
        hasDeliveredSourceReply,
        hookRunner,
        markSourceReplyDelivered,
        replaySafeToolNames,
        replaySafeTools,
        setActiveSessionSystemPrompt,
        settingsManager,
      } = await prepareEmbeddedAttemptAgentSession({
        attempt: params,
        activeContextEngineInfo: activeContextEngine?.info,
        agentCoreThinkingLevel,
        agentDir,
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
        effectiveCwd,
        getCurrentAttemptPluginMetadataSnapshot,
        initialSystemPrompt: systemPromptText,
        markStage: (stage) => prepStages.mark(stage),
        onSessionCreated: (createdSession) => {
          session = createdSession;
        },
        onSystemPromptChanged: (nextSystemPrompt) => {
          systemPromptText = nextSystemPrompt;
        },
        runAbortSignal: runAbortController.signal,
        sessionAgentId,
        sessionLockController,
        sessionManager,
      });
      const sessionBoundary = prepareEmbeddedAttemptSessionBoundary({
        activeSession,
        attempt: params,
        isRawModelRun,
        preparedUserTurnMessage,
        sessionManager,
        setActiveSessionSystemPrompt,
      });
      const { boundaryTimezone, includeBoundaryTimestamp, orphanRepair } = sessionBoundary;
      let prePromptMessageCount = activeSession.messages.length;
      // Session-owned projections survive attempt teardown so already-sent tool results
      // cannot rewrite the provider prompt-cache tail between turns (#99495).
      const sessionPromptState = getEmbeddedSessionPromptState(params.sessionId);
      const toolResultPromptProjectionState = sessionPromptState.toolResults;
      let promptCache: EmbeddedRunAttemptResult["promptCache"];
      const sessionSettleTracker = createEmbeddedAttemptSessionSettleTracker(activeSession);
      const { abortActiveSession, trackPromptSettlePromise } = sessionSettleTracker;
      externalAbortController.setActiveSessionAbort(abortActiveSession);
      buildAbortSettlePromise = sessionSettleTracker.buildAbortSettlePromise;
      abortSessionForYield = () => {
        yieldAbortSettled = abortActiveSession(SESSIONS_YIELD_ABORT_REASON);
      };
      queueYieldInterruptForSession = () => {
        queueSessionsYieldInterruptMessage(activeSession);
      };
      const contextGuards = installEmbeddedAttemptContextGuards({
        activeContextEngine,
        activeSession,
        agentDir,
        attempt: params,
        computerContextEpoch,
        effectiveCwd,
        effectiveWorkspace,
        getPrePromptMessageCount: () => prePromptMessageCount,
        getPromptCache: () => promptCache,
        getPromptCacheRetention: () => effectivePromptCacheRetention,
        getSystemPrompt: () => systemPromptText,
        isOpenAIResponsesApi,
        repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
        sessionAgentId,
        sessionManager,
        settingsManager,
      });
      removeToolResultContextGuard = contextGuards.remove;
      const cacheTrace = createCacheTrace({
        cfg: params.config,
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      const anthropicPayloadLogger = createAnthropicPayloadLogger({
        env: process.env,
        runId: params.runId,
        sessionId: activeSession.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.model.api,
        workspaceDir: params.workspaceDir,
      });
      trajectoryRecorder = await prepareEmbeddedAttemptTrajectory({
        activeSession,
        attempt: params,
        clientToolCount: clientToolDefs.length,
        effectiveToolCount: effectiveTools.length,
        effectiveWorkspace,
        localModelLeanEnabled,
        sessionAgentId,
        ...(systemPromptReport ? { systemPromptReport } : {}),
      });

      const {
        effectiveAgentTransport,
        effectiveExtraParams,
        effectivePromptCacheRetention,
        providerTextTransforms,
        streamStrategy,
      } = await prepareEmbeddedAttemptTransport({
        attempt: params,
        session: activeSession,
        settingsManager,
        providerThinkingLevel,
        sessionAgentId,
        workspaceDir: effectiveWorkspace,
        agentDir,
        abortSignal: runAbortController.signal,
        getProviderRuntimeHandle,
        sandboxSessionKey,
        sandbox,
        codeModeControlsEnabled: codeModeControlsEnabledForRun,
      });
      const { cacheObservabilityEnabled, promptCacheToolNames } =
        installEmbeddedAttemptStreamGuards({
          attempt: params,
          session: activeSession,
          sessionAgentId,
          cacheTrace,
          allCustomTools,
          systemPromptText,
          transcriptPolicy,
          sessionManager,
          sessionLockController,
          isOpenAIResponsesApi,
          replayAllowedToolNames,
          liveAllowedToolNames,
          isYieldDetected: () => yieldDetected,
          clientToolLoopDetection,
          anthropicPayloadLogger,
          onRejectedThinkingReplayRepaired: () => {
            repairedRejectedThinkingReplay = true;
          },
          onIdleTimeout: (error) => idleTimeoutTrigger?.(error),
          effectiveAgentTransport,
          providerTextTransforms,
          abortSignal: runAbortController.signal,
          runTrace,
        });
      prepStages.mark("stream-setup");
      emitPrepStageSummary("stream-ready");
      let promptCacheChangesForTurn: PromptCacheChange[] | null = null;

      let preparedHistory: Awaited<ReturnType<typeof prepareEmbeddedAttemptHistory>>;
      try {
        preparedHistory = await prepareEmbeddedAttemptHistory({
          attempt: params,
          activeSession,
          sessionManager,
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
          systemPromptText,
          transcriptPolicy,
          setActiveSessionSystemPrompt,
        });
      } catch (err) {
        await flushPendingToolResultsAfterIdle({
          agent: activeSession?.agent,
          sessionManager,
          // PERF: If the run was aborted during the setup,
          // skip the idle wait and flush pending results synchronously so we can
          // immediately dispose the session without orphaning tool calls.
          ...(params.abortSignal?.aborted ? { timeoutMs: 0 } : {}),
        });
        activeSession.dispose();
        throw err;
      }
      const {
        contextEnginePromptAuthority,
        contextEngineAssemblySucceeded,
        unwindowedContextEngineMessagesForPrecheck,
      } = preparedHistory;

      let yieldAborted = false;
      const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
      const queueHandleRef: { current?: EmbeddedAgentQueueHandle } = {};
      const abortRun = createEmbeddedAttemptRunAbort({
        abortActiveSession,
        activeSession,
        attempt: params,
        getQueueHandle: () => queueHandleRef.current,
        isProbeSession,
        log,
        runAbortController,
        sessionLockController,
        state: abortState,
      });
      externalAbortController.setRunAbort(abortRun);
      const idleTimeoutTrigger: ((error: Error) => void) | undefined = (error) => {
        idleTimedOut = true;
        abortRun(true, error);
      };
      const abortable = <T>(promise: Promise<T>): Promise<T> =>
        abortableWithSignal(runAbortController.signal, promise);
      const promptActiveSession = (
        prompt: string,
        options?: Parameters<typeof activeSession.prompt>[1],
      ): Promise<void> =>
        withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
          abortable(trackPromptSettlePromise(activeSession.prompt(prompt, options))),
        );
      // Hook runner was already obtained earlier before tool creation.
      const hookAgentId = sessionAgentId;
      const onBlockReply = params.onBlockReply
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReply)
        : undefined;
      const onBlockReplyFlush = params.onBlockReplyFlush
        ? bindOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, params.onBlockReplyFlush)
        : undefined;
      const preparedStream = prepareEmbeddedAttemptStream({
        attempt: params,
        activeSession,
        runtimeChannel,
        hookRunner,
        hookAgentId,
        diagnosticTrace,
        clientToolCallSlots,
        toolSearchTargetTranscriptProjections,
        isReplaySafeTool: (tool) => replaySafeTools.has(tool as never),
        runAbortController,
        abortRun,
        markExternalAbort: () => {
          externalAbort = true;
        },
        getRunState: () => ({
          aborted,
          promptError,
          timedOut,
          yieldDetected,
        }),
        hasDeliveredSourceReply,
        markSourceReplyDelivered,
        onBlockReply,
        onBlockReplyFlush,
        sandboxSessionKey,
        builtinToolNames,
        replaySafeToolNames,
      });
      const {
        subscription,
        queueHandle,
        stopAcceptingSteerMessages,
        getBeforeAgentFinalizeRevisionReason,
      } = preparedStream;
      const { unsubscribe, waitForPendingEvents } = subscription;
      toolSearchCatalogExecutor = preparedStream.toolSearchCatalogExecutor;
      externalAbortController.setCompactionState({
        isPendingOrRetrying: subscription.isCompacting,
        isInFlight: () => activeSession.isCompacting,
      });
      let lastAssistant: AssistantMessage | undefined;
      let currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
      let attemptUsage: NormalizedUsage | undefined;
      let cacheBreak: PromptCacheBreak | null = null;
      let contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
      let finalPromptText: string | undefined;
      queueHandleRef.current = queueHandle;

      const attemptTimeout = prepareEmbeddedAttemptTimeout({
        attempt: params,
        activeSession,
        compactionState: subscription,
        compactionTimeoutMs,
        isProbeSession,
        abortRun,
        markExternalAbort: () => {
          externalAbort = true;
        },
        markTimedOutDuringCompaction: () => {
          timedOutDuringCompaction = true;
        },
        markTimedOutByRunBudget: () => {
          timedOutByRunBudget = true;
        },
      });
      const {
        getRunAbortDeadlineAtMs,
        clearTimers: clearAttemptTimeoutTimers,
        removeAbortSignalListener: removeAttemptAbortSignalListener,
      } = attemptTimeout;
      let messagesSnapshot: AgentMessage[] = [];
      let sessionIdUsed = activeSession.sessionId;
      let sessionFileUsed: string | undefined = params.sessionFile;

      const activeSessionManager = sessionManager;
      let preflightRecovery: EmbeddedRunAttemptResult["preflightRecovery"];
      let promptErrorSource: EmbeddedRunAttemptResult["promptErrorSource"] = null;
      const handleMidTurnPrecheckRequest = (request: MidTurnPrecheckRequest) => {
        const outcome = handleEmbeddedAttemptMidTurnPrecheck({
          attempt: params,
          request,
          sessionAgentId,
          sessionManager: activeSessionManager,
          prePromptMessageCount,
          replaceSessionMessages: (messages) => {
            activeSession.agent.state.messages = messages;
          },
        });
        preflightRecovery = outcome.preflightRecovery;
        if (outcome.promptError) {
          promptError = outcome.promptError;
          promptErrorSource = "precheck";
        }
      };
      let skipPromptSubmission = false;
      let leasedSteering:
        | {
            leaseId: string;
            runIds: readonly string[];
          }
        | undefined;
      const releaseLeasedSteering = (error?: unknown) => {
        if (!leasedSteering) {
          return;
        }
        releasePendingAgentSteeringItems({
          runIds: leasedSteering.runIds,
          leaseId: leasedSteering.leaseId,
          error: error ? formatErrorMessage(error) : undefined,
        });
        leasedSteering = undefined;
      };
      try {
        const promptStartedAt = Date.now();
        if (emptyExplicitToolAllowlistError) {
          promptError = emptyExplicitToolAllowlistError;
          promptErrorSource = "precheck";
          skipPromptSubmission = true;
          log.warn(`[tools] ${emptyExplicitToolAllowlistError.message}`);
        }

        const promptAssembly = await prepareEmbeddedAttemptPromptAssembly({
          attempt: params,
          activeSession,
          sessionManager,
          hookRunner,
          hookAgentId,
          diagnosticTrace,
          isRawModelRun,
          ...(orphanRepair ? { orphanRepair } : {}),
          sessionAgentId,
          runtimeModel: runtimeInfo.model,
          systemPromptText,
          setActiveSessionSystemPrompt,
          setLeasedSteering: (lease) => {
            leasedSteering = lease;
          },
          cache: {
            observabilityEnabled: cacheObservabilityEnabled,
            retention: effectivePromptCacheRetention,
            streamStrategy,
            transport: effectiveAgentTransport,
            toolNames: promptCacheToolNames,
            trace: cacheTrace,
          },
        });
        const { hookCtx, promptBuildPrependContext, promptBuildAppendContext, transcriptLeafId } =
          promptAssembly;
        leasedSteering = promptAssembly.leasedSteering ?? leasedSteering;
        promptCacheChangesForTurn = promptAssembly.promptCacheChangesForTurn;

        try {
          const promptContext = prepareEmbeddedAttemptPromptContext({
            attempt: params,
            ...(boundaryTimezone ? { boundaryTimezone } : {}),
            includeBoundaryTimestamp,
            isRawModelRun,
            messages: activeSession.messages,
            ...(typeof preparedUserTurnMessage?.timestamp === "number"
              ? { preparedUserTurnTimestamp: preparedUserTurnMessage.timestamp }
              : {}),
            prompt: promptAssembly,
            replaceSessionMessages: (messages) => {
              activeSession.agent.state.messages = messages;
            },
            sessionAgentId,
            setActiveSessionSystemPrompt,
            ...(systemPromptReport ? { systemPromptReport } : {}),
            systemPromptText,
            toolResultPromptProjectionState,
          });
          const {
            aggregatePressureEngaged,
            hookMessagesForCurrentPrompt,
            promptForModel,
            systemPromptForHook,
          } = promptContext;
          prePromptMessageCount = promptContext.prePromptMessageCount;
          sessionBoundary.setCurrentUserTimestampOverride(
            promptContext.currentUserTimestampOverride,
          );
          if (aggregatePressureEngaged) {
            // Compaction and aggregate truncation both target about half the window;
            // compact-then-truncate prevents re-hitting the same cap on the next turn.
            preflightRecovery = { route: "compact_then_truncate" };
            promptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
            promptErrorSource = "precheck";
            skipPromptSubmission = true;
          }

          const beforeAgentRunOutcome = await runEmbeddedAttemptBeforeAgentRun({
            attempt: params,
            activeSession,
            hookContext: hookCtx,
            hookMessages: hookMessagesForCurrentPrompt,
            hookRunner,
            modelPrompt: promptForModel,
            sessionManager: activeSessionManager,
            systemPrompt: systemPromptForHook,
            withOwnedSessionWriteLock,
          });
          if (beforeAgentRunOutcome) {
            beforeAgentRunBlocked = true;
            beforeAgentRunBlockedBy = beforeAgentRunOutcome.blockedBy;
            promptError = beforeAgentRunOutcome.promptError;
            promptErrorSource = "hook:before_agent_run";
            skipPromptSubmission = true;
          }

          if (!skipPromptSubmission) {
            const googlePromptCacheStreamFn = await prepareGooglePromptCacheStreamFn({
              apiKey: await resolveEmbeddedAgentApiKey({
                provider: params.provider,
                resolvedApiKey: params.resolvedApiKey,
                authStorage: params.authStorage,
              }),
              extraParams: effectiveExtraParams,
              model: params.model,
              modelId: params.modelId,
              provider: params.provider,
              sessionManager: {
                appendCustomEntry: async (customType, data) => {
                  await withOwnedSessionWriteLock(() => {
                    activeSessionManager.appendCustomEntry(customType, data);
                  });
                },
                getEntries: () => activeSessionManager.getEntries(),
              },
              signal: runAbortController.signal,
              streamFn: activeSession.agent.streamFn,
              systemPrompt: systemPromptText,
            });
            if (googlePromptCacheStreamFn) {
              activeSession.agent.streamFn = googlePromptCacheStreamFn;
            }
          }

          ({
            contextBudgetStatus,
            preflightRecovery,
            promptError,
            promptErrorSource,
            skipPromptSubmission,
          } = await dispatchEmbeddedAttemptPrompt({
            attempt: params,
            ...(activeContextEngine ? { activeContextEngine } : {}),
            activeSession,
            promptContext,
            getCompactionReserveTokens: () => settingsManager.getCompactionReserveTokens(),
            publishState: (state) => {
              contextBudgetStatus = state.contextBudgetStatus;
              preflightRecovery = state.preflightRecovery;
              promptError = state.promptError;
              promptErrorSource = state.promptErrorSource;
              skipPromptSubmission = state.skipPromptSubmission;
            },
            releaseLeasedSteering,
            state: {
              contextBudgetStatus,
              preflightRecovery,
              promptError,
              promptErrorSource,
              skipPromptSubmission,
            },
            execution: {
              effectiveFsWorkspaceOnly,
              effectiveWorkspace,
              sandbox,
              sessionLockController,
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
              systemPromptText,
              toolSearchCompacted: toolSearch.compacted,
              tools,
              trajectoryRecorder,
              transcriptLeafId,
              transport: effectiveAgentTransport,
              uncompactedEffectiveTools,
            },
            preflight: {
              contextEngineAssemblySucceeded,
              contextEnginePromptAuthority,
              includeBoundaryTimestamp,
              sessionAgentId,
              sessionManager: activeSessionManager,
              ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
              ...(unwindowedContextEngineMessagesForPrecheck
                ? { unwindowedContextEngineMessagesForPrecheck }
                : {}),
              withOwnedSessionWriteLock,
            },
            submission: {
              ...(promptBuildAppendContext ? { appendContext: promptBuildAppendContext } : {}),
              ...(leasedSteering ? { leasedSteering } : {}),
              onFinalPromptText: (prompt) => {
                finalPromptText = prompt;
              },
              onSteeringAcknowledged: () => {
                leasedSteering = undefined;
              },
              ...(promptBuildPrependContext ? { prependContext: promptBuildPrependContext } : {}),
              promptActiveSession,
              sessionPromptState,
              toolResultPromptProjectionState,
              trajectoryRecorder,
              transcriptLeafId,
            },
          }));
        } catch (err) {
          const promptErrorOutcome = await handleEmbeddedAttemptPromptError({
            activeSession,
            attempt: params,
            error: err,
            handleMidTurnPrecheckRequest,
            markYieldAborted: () => {
              yieldAborted = true;
              cleanupYieldAborted = true;
              aborted = false;
            },
            releaseLeasedSteering,
            sessionLockController,
            withOwnedSessionWriteLock,
            yieldAbortSettled,
            yieldDetected,
            yieldMessage,
          });
          if (promptErrorOutcome.promptFailure) {
            promptError = promptErrorOutcome.promptFailure.error;
            promptErrorSource = promptErrorOutcome.promptFailure.source;
          }
        } finally {
          stopAcceptingSteerMessages();
          log.debug(
            `embedded run prompt end: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - promptStartedAt}`,
          );
        }

        const pendingMidTurnPrecheckRequest = contextGuards.takePendingMidTurnPrecheckRequest();
        if (pendingMidTurnPrecheckRequest) {
          const request = pendingMidTurnPrecheckRequest;
          await sessionLockController.waitForSessionEvents(activeSession);
          await withOwnedSessionWriteLock(() => {
            removeTrailingMidTurnPrecheckAssistantError({
              activeSession,
              sessionManager: activeSessionManager,
            });
            if (!preflightRecovery && promptErrorSource !== "precheck") {
              promptError = null;
              promptErrorSource = null;
              handleMidTurnPrecheckRequest(request);
            }
          });
        }

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
            promptCache = settledStream.promptCache;
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
            prePromptMessageCount,
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
          promptCache,
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
