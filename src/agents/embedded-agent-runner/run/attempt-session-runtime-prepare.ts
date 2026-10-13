import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import { createCacheTrace } from "../../cache-trace.js";
import { bindCodeModeSessionStore } from "../../code-mode-session-store.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import { getOpenClawSystemUpdateKind } from "../../internal-runtime-context.js";
import type { AgentSession } from "../../sessions/index.js";
import { withSessionManagerAppend } from "../../sessions/session-manager-append-admission.js";
import { getProviderPromptState } from "../provider-prompt-state.js";
import {
  retainEmbeddedSessionPromptState,
  beginSessionSystemPrompt,
  prepareSessionSystemPrompt,
  retireSessionSystemPrompt,
} from "../session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "../tool-result-truncation.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import {
  prepareEmbeddedAttemptAgentSession,
  prepareEmbeddedAttemptSessionBoundary,
  prepareEmbeddedAttemptSessionManager,
} from "./attempt-session-prepare.js";
import {
  createEmbeddedAttemptSessionSettleTracker,
  type EmbeddedAttemptSessionResources,
} from "./attempt-session-settle.js";
import { installEmbeddedAttemptContextGuards, type EmbeddedAttemptSetup } from "./attempt-setup.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-settle.js";
import type { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import type { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import { prepareEmbeddedAttemptTrajectory } from "./attempt-trajectory.js";
import type { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import { measureEmbeddedAgentPreparation } from "./preparation-timing.js";
import type {
  EmbeddedAttemptExternalAbortController,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./types.js";

type SessionSettleTracker = ReturnType<typeof createEmbeddedAttemptSessionSettleTracker>;

type EmbeddedAttemptSessionRuntimeState = {
  currentTurnImageFailureCount: number;
  prePromptMessageCount: number;
  promptCache: EmbeddedRunAttemptResult["promptCache"];
  systemPromptText: string;
};

export async function prepareEmbeddedAttemptSessionRuntime(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: ContextEngine;
  agentDir: string;
  isRawModelRun: boolean;
  resolveActiveContextEnginePluginId: () => string | undefined;
  setup: EmbeddedAttemptSetup;
  toolBase: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolBase>>;
  toolCatalog: Awaited<ReturnType<typeof prepareEmbeddedAttemptToolCatalog>>;
  bundleTools: Awaited<ReturnType<typeof prepareEmbeddedAttemptBundleTools>>;
  systemPrompt: Awaited<ReturnType<typeof prepareEmbeddedAttemptSystemPrompt>>;
  sessionLock: Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>;
  runAbortSignal: AbortSignal;
  externalAbortController: Pick<EmbeddedAttemptExternalAbortController, "setActiveSessionAbort">;
  resources: EmbeddedAttemptSessionResources;
  onSessionYieldReady: (input: {
    abortActiveSession: SessionSettleTracker["abortActiveSession"];
    activeSession: AgentSession;
  }) => void;
}) {
  const { attempt, resources, runAbortSignal, sessionLock, toolBase } = input;
  const {
    agentCoreThinkingLevel,
    effectiveCwd,
    effectiveFsWorkspaceOnly,
    effectiveWorkspace,
    getCurrentAttemptPluginMetadataSnapshot,
    getProviderRuntimeHandle,
    prepStages,
    providerThinkingLevel,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  } = input.setup;
  const {
    catalogToolHookContext,
    deferredDirectoryToolsCallable,
    effectiveTools,
    toolSearchRunPlan,
  } = input.toolCatalog;
  const { clientTools, uncompactedEffectiveTools } = input.bundleTools;
  const {
    codeModeControlsEnabledForRun,
    computerContextEpoch,
    localModelLeanEnabled,
    replaySafetyOptions,
    toolSearchCatalogRef,
    toolSearchRuntimeConfig,
  } = toolBase;
  const { systemPromptReport, systemPromptText } = input.systemPrompt;
  const effectiveToolCount = effectiveTools.length;
  const sessionPreparation = {
    attempt,
    ...(input.activeContextEngine ? { activeContextEngine: input.activeContextEngine } : {}),
    agentDir: input.agentDir,
    effectiveCwd,
    effectiveWorkspace,
    sessionAgentId,
  };
  const preparedSessionManager = await measureEmbeddedAgentPreparation(
    "attempt.history",
    () =>
      prepareEmbeddedAttemptSessionManager({
        ...sessionPreparation,
        onSessionManagerCreated: (manager) => {
          resources.sessionManager = manager;
        },
        replayAllowedToolNames: toolSearchRunPlan.replayAllowedToolNames,
        resolveActiveContextEnginePluginId: input.resolveActiveContextEnginePluginId,
        withOwnedTranscriptWrite: sessionLock.withOwnedTranscriptWrite,
      }),
    { config: attempt.config },
  );
  const { isOpenAIResponsesApi, preparedUserTurnMessage, sessionManager, transcriptPolicy } =
    preparedSessionManager;
  if (codeModeControlsEnabledForRun && toolSearchCatalogRef) {
    bindCodeModeSessionStore(
      toolSearchCatalogRef,
      sessionManager,
      sessionLock.withOwnedTranscriptWrite,
    );
  }
  const promptStateLease = retainEmbeddedSessionPromptState(attempt.sessionId);
  resources.promptStateLease = promptStateLease;
  const sessionPromptState = promptStateLease.state;
  const usesSystemPromptSeries =
    !input.isRawModelRun && attempt.operation !== "settled-tool-finalization";
  const promptRouteKey = JSON.stringify([
    attempt.provider,
    attempt.modelId,
    attempt.model.api,
    attempt.model.baseUrl,
    transcriptPolicy.inHistorySystemUpdates === true,
    // Personal bootstrap follows the selected human, not only the session ID.
    attempt.bootstrapUserProfileId,
  ]);
  // Retire old overrides before new carriers without checkpointing unadmitted notices.
  const retireSystemPromptUpdates = () =>
    sessionLock.withOwnedTranscriptWrite(() =>
      withSessionManagerAppend(sessionManager, async () => {
        runAbortSignal.throwIfAborted();
        await retireSessionSystemPrompt(sessionPromptState, promptRouteKey, (customType, data) =>
          sessionManager.appendCustomEntryAsync(customType, data),
        );
      }),
    );
  if (
    usesSystemPromptSeries &&
    beginSessionSystemPrompt({
      state: sessionPromptState,
      routeKey: promptRouteKey,
      enabled: transcriptPolicy.inHistorySystemUpdates === true,
      entries: sessionManager.getBranch(),
    })
  ) {
    await retireSystemPromptUpdates();
  }
  let freshSystemPrompt = systemPromptText;
  let projectedSystemPrompt: string | undefined;
  const prepareSystemPromptUpdate =
    usesSystemPromptSeries && transcriptPolicy.inHistorySystemUpdates
      ? async (systemPrompt: string, freshlyRendered = false) => {
          if (freshlyRendered || systemPrompt !== projectedSystemPrompt) {
            freshSystemPrompt = systemPrompt;
          }
          const prepared = prepareSessionSystemPrompt({
            state: sessionPromptState,
            routeKey: promptRouteKey,
            systemPrompt: freshSystemPrompt,
            entries: sessionManager.getBranch(),
          });
          let restartRecorded = false;
          if (prepared.restart && resources.session) {
            await retireSystemPromptUpdates();
            restartRecorded = true;
            resources.session.agent.state.messages = resources.session.messages.filter(
              (message) => getOpenClawSystemUpdateKind(message) !== "prompt-update",
            );
          }
          projectedSystemPrompt = prepared.systemPrompt;
          return { ...prepared, commit: () => prepared.commit(restartRecorded) };
        }
      : undefined;
  resources.getUserTranscriptContexts =
    preparedSessionManager.userMessageBoundary.getUserTranscriptContexts;

  const state: EmbeddedAttemptSessionRuntimeState = {
    currentTurnImageFailureCount: 0,
    prePromptMessageCount: 0,
    promptCache: undefined,
    systemPromptText,
  };
  const preparedAgentSession = await withOwnedSessionTranscriptWrites(
    sessionLock.ownedTranscriptWriteContext,
    async () =>
      measureEmbeddedAgentPreparation(
        "attempt.actor",
        () =>
          prepareEmbeddedAttemptAgentSession({
            ...sessionPreparation,
            ...(input.activeContextEngine
              ? { activeContextEngineInfo: input.activeContextEngine.info }
              : {}),
            agentCoreThinkingLevel,
            clientToolPreparation: {
              catalogToolHookContext,
              clientTools,
              codeModeControlsEnabledForRun,
              deferredDirectoryToolsCallable,
              effectiveTools,
              replaySafetyOptions,
              sandboxSessionKey,
              sessionAgentId,
              toolSearchCatalogRef,
              toolSearchRuntimeConfig,
              uncompactedEffectiveTools,
              getToolAbortSignal: () => toolBase.toolAbortSignal,
            },
            getCurrentAttemptPluginMetadataSnapshot,
            initialSystemPrompt: state.systemPromptText,
            prepareSystemPromptUpdate,
            markStage: (stage) => prepStages.mark(stage),
            onSessionCreated: (session) => {
              resources.session = session;
            },
            onSystemPromptChanged: (nextSystemPrompt) => {
              state.systemPromptText = nextSystemPrompt;
            },
            runAbortSignal,
            transcriptLifecycle: sessionLock.transcriptLifecycle,
            sessionManager,
            prepareInitialUserTurnReplay: preparedSessionManager.prepareInitialUserTurnReplay,
          }),
        { config: attempt.config },
      ),
  );
  const { activeSession, setActiveSessionSystemPrompt, settingsManager } = preparedAgentSession;
  const recordCurrentTurnImageFailure = (count: number) => {
    state.currentTurnImageFailureCount = Math.max(state.currentTurnImageFailureCount, count);
  };
  await attempt.userTurnTranscriptRecorder?.waitForRuntimePersistence();
  const boundary = await measureEmbeddedAgentPreparation(
    "attempt.history-boundary",
    () =>
      sessionLock.withOwnedTranscriptWrite(() =>
        prepareEmbeddedAttemptSessionBoundary({
          abortSignal: runAbortSignal,
          activeSession,
          appendOnlyRuntimeContext: transcriptPolicy.appendOnlyRuntimeContext,
          inHistorySystemUpdates: transcriptPolicy.inHistorySystemUpdates,
          attempt,
          ...preparedSessionManager.userMessageBoundary,
          isRawModelRun: input.isRawModelRun,
          sessionManager,
          setActiveSessionSystemPrompt,
        }),
      ),
    { config: attempt.config },
  );
  state.prePromptMessageCount = activeSession.messages.length;

  // Session-owned projections survive attempt teardown so already-sent tool results
  // cannot rewrite the provider prompt-cache tail between turns (#99495).
  const toolResultPromptProjectionState = sessionPromptState.toolResults;
  if (!input.isRawModelRun) {
    restoreCacheTtlToolResultProjections(
      toolResultPromptProjectionState,
      sessionManager.getToolResultProjectionEntries(),
    );
  }
  const settleTracker = createEmbeddedAttemptSessionSettleTracker(activeSession);
  input.externalAbortController.setActiveSessionAbort(settleTracker.abortActiveSession);
  resources.buildAbortSettlePromise = settleTracker.buildAbortSettlePromise;
  input.onSessionYieldReady({
    abortActiveSession: settleTracker.abortActiveSession,
    activeSession,
  });

  // Guard hooks execute during prompt submission, after transport preparation.
  const contextGuards = installEmbeddedAttemptContextGuards({
    ...sessionPreparation,
    activeSession,
    computerContextEpoch,
    dropThinkingBlocksForEstimate: transcriptPolicy.dropThinkingBlocks,
    effectiveFsWorkspaceOnly,
    getPrePromptMessageCount: () => state.prePromptMessageCount,
    getPromptCache: () => state.promptCache,
    onCurrentTurnImageFailure: recordCurrentTurnImageFailure,
    getPromptCacheRetention: () => transport.effectivePromptCacheRetention,
    getCompactionReplayEnabled: () => transport.compactionReplayEnabled,
    getServerToolClearingEnabled: () => transport.serverToolClearingEnabled,
    toolResultPromptProjectionState,
    getSystemPrompt: () => state.systemPromptText,
    isOpenAIResponsesApi,
    repairToolUseResultPairing: transcriptPolicy.repairToolUseResultPairing,
    sessionManager,
    settingsManager,
    sandbox,
  });
  resources.removeToolResultContextGuard = contextGuards.remove;

  const traceContext = {
    env: process.env,
    runId: attempt.runId,
    sessionId: activeSession.sessionId,
    sessionKey: attempt.sessionKey,
    provider: attempt.provider,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    workspaceDir: attempt.workspaceDir,
  };
  const cacheTrace = createCacheTrace({ cfg: attempt.config, ...traceContext });
  const anthropicPayloadLogger = createAnthropicPayloadLogger(traceContext);
  const trajectoryRecorder = await prepareEmbeddedAttemptTrajectory({
    ...sessionPreparation,
    activeSession,
    transcriptOwner: sessionLock.ownedTranscriptWriteContext,
    clientToolCount: preparedAgentSession.clientToolDefs.length,
    effectiveToolCount,
    localModelLeanEnabled,
    ...(systemPromptReport ? { systemPromptReport } : {}),
  });
  resources.trajectoryRecorder = trajectoryRecorder;

  const transport = await prepareEmbeddedAttemptTransport({
    attempt,
    assertCronRootCurrent: sessionLock.assertCronRootCurrent,
    session: activeSession,
    settingsManager,
    providerThinkingLevel,
    sessionAgentId,
    workspaceDir: effectiveWorkspace,
    workspaceOnly: effectiveFsWorkspaceOnly,
    agentDir: input.agentDir,
    abortSignal: runAbortSignal,
    getProviderRuntimeHandle,
    onCurrentTurnImageFailure: recordCurrentTurnImageFailure,
    sandboxSessionKey,
    ...(sandbox !== undefined ? { sandbox } : {}),
    codeModeControlsEnabled: codeModeControlsEnabledForRun,
    providerPromptState: {
      state: getProviderPromptState(attempt.runId),
      effectiveContextTokenBudget: Math.max(
        1,
        Math.floor(
          attempt.contextTokenBudget ?? attempt.model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        ),
      ),
      ...(trajectoryRecorder ? { recordEvent: trajectoryRecorder.recordEvent } : {}),
    },
  });

  return {
    agentSession: preparedAgentSession,
    anthropicPayloadLogger,
    boundary,
    cacheTrace,
    contextGuards,
    isOpenAIResponsesApi,
    preparedUserTurnMessage,
    prepareSystemPromptUpdate,
    sessionManager,
    sessionPromptState,
    settleTracker,
    state,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transcriptPolicy,
    transport,
  };
}
