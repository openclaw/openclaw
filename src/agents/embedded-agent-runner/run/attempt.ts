/**
 * Orchestrates one embedded-agent attempt from prompt setup through stream result.
 */
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import {
  bindOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptCacheSnapshot,
  type OwnedSessionTranscriptWriteOptions,
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
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { acquireSessionWriteLock } from "../../session-write-lock.js";
import type { AgentSession } from "../../sessions/index.js";
import { releasePendingAgentSteeringItems } from "../../subagent-registry.js";
import {
  clearToolSearchCatalog,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import type { NormalizedUsage } from "../../usage.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
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
import { completeEmbeddedAttemptAfterTurn } from "./attempt-after-turn.js";
import { runEmbeddedAttemptBeforeAgentRun } from "./attempt-before-agent-run.js";
import { prepareEmbeddedAttemptBootstrap } from "./attempt-bootstrap-prepare.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { installEmbeddedAttemptContextGuards } from "./attempt-context-guards.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import { prepareEmbeddedAttemptPromptAssembly } from "./attempt-prompt-assembly.js";
import { prepareEmbeddedAttemptPromptContext } from "./attempt-prompt-context.js";
import { observeEmbeddedAttemptPrompt } from "./attempt-prompt-observability.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { completeEmbeddedAttemptResult } from "./attempt-result.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-boundary.js";
import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-cleanup.js";
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
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-transport.js";
import { installEmbeddedAttemptStreamGuards } from "./attempt-stream.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-base-prepare.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import { normalizeCurrentPromptTextForLlmBoundary } from "./attempt.llm-boundary.js";
import { resolveEmbeddedAttemptSessionWriteLockOptions } from "./attempt.run-decisions.js";
import {
  acquireEmbeddedAttemptSessionFileOwner,
  type EmbeddedAttemptSessionFileOwner,
  createEmbeddedAttemptSessionLockController,
  installPromptSubmissionLockRelease,
} from "./attempt.session-lock.js";
import {
  isSessionsYieldAbortError,
  persistSessionsYieldContextMessage,
  queueSessionsYieldInterruptMessage,
  SESSIONS_YIELD_ABORT_REASON,
  stripSessionsYieldArtifacts,
  waitForSessionsYieldAbortSettle,
} from "./attempt.sessions-yield.js";
import { detectAndLoadPromptImages } from "./images.js";
import { isMidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
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

    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionWriteLockOptions = resolveEmbeddedAttemptSessionWriteLockOptions({
      config: params.config,
      compactionTimeoutMs,
    });
    await externalAbortController.throwIfFiredAfterPrepCleanup();
    retainedSessionFileOwner = await acquireEmbeddedAttemptSessionFileOwner({
      sessionFile: params.sessionFile,
      timeoutMs: sessionWriteLockOptions.maxHoldMs,
      signal: params.abortSignal,
    });
    let sessionManager: ReturnType<typeof guardSessionManager> | undefined;
    const sessionLockController = await createEmbeddedAttemptSessionLockController({
      acquireSessionWriteLock,
      initialAcquireSignal: params.abortSignal,
      lockOptions: {
        sessionFile: params.sessionFile,
        ...sessionWriteLockOptions,
      },
      mergePromptReleasedSessionEntries: (entries) => {
        if (!sessionManager) {
          throw new Error("session manager unavailable during prompt-released entry merge");
        }
        return sessionManager.mergePromptReleasedSessionEntries(entries, { persistLeaf: true });
      },
      reloadPromptReleasedSessionFile: () => {
        if (!sessionManager) {
          throw new Error("session manager unavailable during prompt-released file reload");
        }
        sessionManager.setSessionFile(params.sessionFile);
      },
    });
    releaseRetainedSessionLock = () => sessionLockController.dispose();
    const ownedTranscriptWriteContext = {
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      canAdvanceSessionEntryCache: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
        sessionLockController.canAdvanceSessionEntryCache(snapshot),
      publishSessionFileSnapshot: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
        sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
      withSessionWriteLock: <T>(
        operation: () => Promise<T> | T,
        options?: OwnedSessionTranscriptWriteOptions<T>,
      ) => sessionLockController.withSessionWriteLock(operation, options),
    };
    const withOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T): Promise<T> =>
      withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
        sessionLockController.withSessionWriteLock(operation),
      );
    externalAbortController.arm();
    // The signal can fire while the eager session lock is being acquired.
    // Recheck after arming so a stopped run never reaches session creation or provider prompt.
    await externalAbortController.throwIfFiredAfterPrepCleanup();

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
      let lastCallUsage: NormalizedUsage | undefined;
      let contextBudgetStatus: EmbeddedRunAttemptResult["contextBudgetStatus"];
      let compactionOccurredThisAttempt = false;
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
            contextTokenBudget,
            effectivePrompt,
            hookMessagesForCurrentPrompt,
            promptForModel,
            promptSubmission,
            promptToolResultAggregateMaxChars,
            promptToolResultMaxChars,
            runtimeContextMessageForCurrentTurn,
            systemPromptForHook,
          } = promptContext;
          let promptForSession = promptContext.promptForSession;
          prePromptMessageCount = promptContext.prePromptMessageCount;
          sessionBoundary.setCurrentUserTimestampOverride(
            promptContext.currentUserTimestampOverride,
          );
          let modelBoundPrompt = promptForModel;
          let beforeAgentRunTransformedPrompt = false;
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
          if (beforeAgentRunOutcome?.kind === "block") {
            beforeAgentRunBlocked = true;
            beforeAgentRunBlockedBy = beforeAgentRunOutcome.blockedBy;
            promptError = beforeAgentRunOutcome.promptError;
            promptErrorSource = "hook:before_agent_run";
            skipPromptSubmission = true;
          } else if (beforeAgentRunOutcome?.kind === "transform") {
            modelBoundPrompt = beforeAgentRunOutcome.prompt;
            beforeAgentRunTransformedPrompt = true;
            // A transform outcome carries a security/redaction intent: what the
            // model sees must also be what gets persisted, otherwise the raw
            // text re-enters context on the next turn via session history.
            promptForSession = modelBoundPrompt;
            if (promptContext.currentUserTimestampOverride) {
              sessionBoundary.setCurrentUserTimestampOverride({
                timestamp: promptContext.currentUserTimestampOverride.timestamp,
                text: promptForSession,
              });
            }
          }
          if (systemPromptReport?.currentTurn) {
            systemPromptReport.currentTurn.promptChars = modelBoundPrompt.length;
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
            installPromptSubmissionLockRelease({
              session: activeSession,
              waitForSessionEvents: (sessionToDrain) =>
                sessionLockController.waitForSessionEvents(sessionToDrain),
              releaseForPrompt: () => sessionLockController.releaseForPrompt(),
              reacquireAfterPrompt: () => sessionLockController.reacquireAfterPrompt(),
              sessionKey: params.sessionKey,
              sessionFile: params.sessionFile,
              withSessionWriteLock: (run, options) =>
                sessionLockController.withSessionWriteLock(run, options),
              canAdvanceSessionEntryCache: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
                sessionLockController.canAdvanceSessionEntryCache(snapshot),
              publishSessionFileSnapshot: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
                sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
            });
          }

          const imageDetectionPrompt =
            modelBoundPrompt === promptForModel ? promptSubmission.prompt : modelBoundPrompt;
          // Images are prompt-local. A transform replaces the model-bound prompt,
          // so image refs must follow the transformed text instead of the transcript.
          const imageResult = skipPromptSubmission
            ? {
                images: [],
                detectedRefs: [],
                loadedCount: 0,
                skippedCount: 0,
              }
            : await detectAndLoadPromptImages({
                prompt: imageDetectionPrompt,
                workspaceDir: effectiveWorkspace,
                model: params.model,
                existingImages: params.images,
                imageOrder: params.imageOrder,
                maxBytes: MAX_IMAGE_BYTES,
                maxDimensionPx: resolveImageSanitizationLimits(params.config).maxDimensionPx,
                workspaceOnly: effectiveFsWorkspaceOnly,
                // Enforce sandbox path restrictions when sandbox is enabled
                sandbox:
                  sandbox?.enabled && sandbox?.fsBridge
                    ? { root: sandbox.workspaceDir, bridge: sandbox.fsBridge }
                    : undefined,
              });

          const llmBoundaryPromptForPrecheck = normalizeCurrentPromptTextForLlmBoundary({
            prompt: modelBoundPrompt,
            ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
            ...(includeBoundaryTimestamp ? {} : { includeTimestamp: false }),
            ...(typeof preparedUserTurnMessage?.timestamp === "number"
              ? { currentUserTimestamp: preparedUserTurnMessage.timestamp }
              : {}),
          });
          const reserveTokens = settingsManager.getCompactionReserveTokens();
          skipPromptSubmission = observeEmbeddedAttemptPrompt({
            attempt: params,
            cacheTrace,
            contextTokenBudget,
            diagnosticTrace,
            // A transform outcome redacts the model-bound prompt; feed that redacted
            // text into cache/trajectory/diagnostic recording instead of the raw one.
            effectivePrompt: beforeAgentRunTransformedPrompt ? modelBoundPrompt : effectivePrompt,
            effectiveTools,
            hookAgentId,
            hookMessagesForCurrentPrompt,
            hookRunner,
            imageCount: imageResult.images.length,
            isRawModelRun,
            llmBoundaryPromptForPrecheck,
            promptForModel: modelBoundPrompt,
            promptSubmissionRuntimeOnly: promptSubmission.runtimeOnly,
            reserveTokens,
            runTrace,
            sessionMessages: activeSession.messages,
            skipPromptSubmission,
            streamStrategy,
            systemPromptForHook,
            systemPromptText,
            toolSearchCompacted: toolSearch.compacted,
            tools,
            trajectoryRecorder,
            transcriptLeafId,
            transport: effectiveAgentTransport,
            uncompactedEffectiveTools,
          }).skipPromptSubmission;

          const promptPreflight = await prepareEmbeddedAttemptPromptPreflight({
            attempt: params,
            ...(activeContextEngine ? { activeContextEngine } : {}),
            contextEngineAssemblySucceeded,
            contextEnginePromptAuthority,
            contextTokenBudget,
            hookMessagesForCurrentPrompt,
            includeBoundaryTimestamp,
            promptForPrecheck: llmBoundaryPromptForPrecheck,
            reserveTokens,
            sessionAgentId,
            sessionManager: activeSessionManager,
            sessionMessageCount: activeSession.messages.length,
            state: {
              contextBudgetStatus,
              preflightRecovery,
              promptError,
              promptErrorSource,
              skipPromptSubmission,
            },
            systemPrompt: systemPromptForHook,
            ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
            toolResultMaxChars: promptToolResultMaxChars,
            ...(unwindowedContextEngineMessagesForPrecheck
              ? { unwindowedContextEngineMessagesForPrecheck }
              : {}),
            withOwnedSessionWriteLock,
          });
          ({
            contextBudgetStatus,
            preflightRecovery,
            promptError,
            promptErrorSource,
            skipPromptSubmission,
          } = promptPreflight);

          if (!skipPromptSubmission) {
            await submitEmbeddedAttemptPrompt({
              attempt: params,
              activeSession,
              ...(promptBuildAppendContext ? { appendContext: promptBuildAppendContext } : {}),
              contextTokenBudget,
              images: imageResult.images,
              ...(leasedSteering ? { leasedSteering } : {}),
              modelPrompt: modelBoundPrompt,
              onFinalPromptText: (prompt) => {
                finalPromptText = prompt;
              },
              onSteeringAcknowledged: () => {
                leasedSteering = undefined;
              },
              ...(promptBuildPrependContext ? { prependContext: promptBuildPrependContext } : {}),
              promptActiveSession,
              ...(runtimeContextMessageForCurrentTurn
                ? { runtimeContextMessage: runtimeContextMessageForCurrentTurn }
                : {}),
              runtimeOnly: promptSubmission.runtimeOnly === true,
              sessionPromptState,
              systemPrompt: systemPromptForHook,
              toolResultAggregateMaxChars: promptToolResultAggregateMaxChars,
              toolResultMaxChars: promptToolResultMaxChars,
              toolResultPromptProjectionState,
              trajectoryRecorder,
              transcriptLeafId,
              // A transform outcome redacts the session-recorded prompt too, so the
              // model-boundary swap in installModelPromptTransform (behind this call)
              // becomes a no-op and the redacted text is what persists (#redaction fix).
              transcriptPrompt: beforeAgentRunTransformedPrompt
                ? modelBoundPrompt
                : promptForSession,
            });
          } else {
            releaseLeasedSteering(promptError ?? "prompt submission skipped");
          }
        } catch (err) {
          releaseLeasedSteering(err);
          yieldAborted = yieldDetected && isSessionsYieldAbortError(err);
          cleanupYieldAborted = yieldAborted;
          if (yieldAborted) {
            aborted = false;
            await waitForSessionsYieldAbortSettle({
              settlePromise: yieldAbortSettled,
              runId: params.runId,
              sessionId: params.sessionId,
            });
            await sessionLockController.releaseHeldLockForAbort();
            await sessionLockController.waitForSessionEvents(activeSession);
            await withOwnedSessionWriteLock(async () => {
              stripSessionsYieldArtifacts(activeSession);
              if (yieldMessage) {
                await persistSessionsYieldContextMessage(activeSession, yieldMessage);
              }
            });
          } else if (isMidTurnPrecheckSignal(err)) {
            await sessionLockController.waitForSessionEvents(activeSession);
            await withOwnedSessionWriteLock(() => {
              handleMidTurnPrecheckRequest(err.request);
            });
          } else {
            promptError = err;
            promptErrorSource = "prompt";
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

        await sessionLockController.waitForSessionEvents(activeSession);
        await waitForPendingEvents();
        if (repairedRejectedThinkingReplay) {
          activeSession.agent.state.messages = activeSessionManager.buildSessionContext().messages;
        }
        await sessionLockController.releaseForPrompt();

        const streamSettleState = {
          promptError,
          promptErrorSource,
          yieldAborted,
          sessionIdUsed,
        };
        const settledStream = await settleEmbeddedAttemptStream({
          attempt: params,
          activeSession,
          sessionManager: activeSessionManager,
          sessionLockController,
          withOwnedSessionWriteLock,
          subscription,
          state: streamSettleState,
          readLifecycleState: () => ({
            aborted,
            timedOut,
            timedOutDuringCompaction,
          }),
          markTimedOutDuringCompaction: () => {
            timedOutDuringCompaction = true;
          },
          runAbortDeadlineAtMs: getRunAbortDeadlineAtMs(),
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
          shouldFlushForContextEngine: Boolean(
            activeContextEngine && !getBeforeAgentFinalizeRevisionReason(),
          ),
        }).catch((err: unknown) => {
          // Preserve the outer lifecycle flags when settlement fails after
          // recording a timeout or prompt error.
          promptError = streamSettleState.promptError;
          promptErrorSource = streamSettleState.promptErrorSource;
          throw err;
        });
        promptError = settledStream.promptError;
        promptErrorSource = settledStream.promptErrorSource;
        timedOutDuringCompaction = settledStream.timedOutDuringCompaction;
        compactionOccurredThisAttempt = settledStream.compactionOccurredThisAttempt;
        messagesSnapshot = settledStream.messagesSnapshot;
        sessionIdUsed = settledStream.sessionIdUsed;
        lastAssistant = settledStream.lastAssistant;
        currentAttemptAssistant = settledStream.currentAttemptAssistant;
        attemptUsage = settledStream.attemptUsage;
        cacheBreak = settledStream.cacheBreak;
        lastCallUsage = settledStream.lastCallUsage;
        promptCache = settledStream.promptCache;

        const beforeAgentFinalizeRevisionReason = getBeforeAgentFinalizeRevisionReason();
        const afterTurn = await completeEmbeddedAttemptAfterTurn({
          attempt: params,
          activeContextEngine,
          activeSession,
          sessionManager: activeSessionManager,
          sessionLockController,
          withOwnedSessionWriteLock,
          state: {
            promptError,
            yieldAborted,
            sessionIdUsed,
            sessionFileUsed,
            messagesSnapshot,
            prePromptMessageCount,
            contextEngineAfterTurnCheckpoint: contextGuards.getAfterTurnCheckpoint(),
            lastCallUsage,
            promptCache,
            ...(beforeAgentFinalizeRevisionReason ? { beforeAgentFinalizeRevisionReason } : {}),
            compactionOccurredThisAttempt,
          },
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
