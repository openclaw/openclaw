import {
  mergeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
  setAgentRunAttemptTerminalFailure,
  type AgentRunAttemptFailureSource,
} from "../../agent-run-terminal-outcome.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import {
  buildAgentRunBlockedUserMessage,
  runBeforeAgentRunGate,
} from "../../harness/before-agent-run.js";
import {
  isOpenClawSystemUpdateMessage,
  resolvePendingRuntimeContextReplay,
} from "../../internal-runtime-context.js";
import { agentSessionDeferThresholdCompaction } from "../../sessions/agent-session-types.js";
import {
  createCompactionRequestBudget,
  type CompactionRequestBudget,
} from "../../sessions/compaction/request-budget.js";
import { withSessionManagerAppend } from "../../sessions/session-manager-append-admission.js";
import { prepareGooglePromptCacheStreamFn } from "../google-prompt-cache.js";
import { log } from "../logger.js";
import {
  persistToolResultProjections,
  persistSessionSystemPrompt,
  persistSessionToolSurface,
} from "../session-prompt-state.js";
import { resolveEmbeddedAgentApiKey } from "../stream-resolution.js";
import { createAbortableError, isOpenClawAbortableWrapper } from "./abortable.js";
import type { EmbeddedAttemptExecutionPhaseInput } from "./attempt-execution-types.js";
import {
  prepareEmbeddedAttemptPromptAssembly,
  prepareEmbeddedAttemptPromptContext,
} from "./attempt-prompt-build.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import {
  handleEmbeddedAttemptPromptError,
  submitEmbeddedAttemptPrompt,
} from "./attempt-prompt-submit.js";
import { observeEmbeddedAttemptPrompt } from "./attempt-prompt-support.js";
import type { PreparedStreamRuntime } from "./attempt-stream-runtime.types.js";
import { removeTrailingMidTurnPrecheckAssistantError } from "./attempt-transcript-helpers.js";
import {
  createChatGPTV2CompactionBoundary,
  isChatGPTV2CompactionEligible,
} from "./chatgpt-v2-compaction.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import { sessionMessagesContainIdempotencyKey } from "./pre-persisted-user-turn.js";
import { estimateToolSchemaTokenPressure } from "./preemptive-compaction.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

type PromptPreflightState = Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0]["state"];

export type EmbeddedAttemptPromptState = Pick<
  PromptPreflightState,
  "contextBudgetStatus" | "preflightRecovery"
> & {
  finalPromptText?: string;
  yieldAborted: boolean;
};

export async function runEmbeddedAttemptPromptPhase(
  input: EmbeddedAttemptExecutionPhaseInput & { preparedStreamRuntime: PreparedStreamRuntime },
  promptState: EmbeddedAttemptPromptState,
): Promise<{ promptStartedAt: number; transcriptLeafId: string | null }> {
  const {
    attempt,
    activeContextEngine,
    isRawModelRun,
    prepared,
    preparedStreamRuntime,
    runAbortController,
  } = input;
  const { sessionRuntime, promptToolPolicy } = prepared;
  const {
    agentSession: {
      activeSession,
      compactionEnabled,
      hookRunner,
      setActiveSessionSystemPrompt,
      settingsManager,
    },
    boundary: {
      boundaryTimezone,
      includeBoundaryTimestamp,
      orphanRepair,
      setCurrentUserTimestampOverride,
    },
    cacheTrace,
    contextGuards,
    preparedUserTurnMessage,
    sessionManager,
    sessionPromptState,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transcriptPolicy: { appendOnlyRuntimeContext, inHistorySystemUpdates },
    transport: {
      effectiveAgentTransport,
      effectiveExtraParams,
      streamStrategy,
      compactionReplayEnabled,
    },
  } = sessionRuntime;
  const { effectiveFsWorkspaceOnly, effectiveWorkspace, sandbox, sessionAgentId } = input.setup;
  const {
    history: { contextEnginePromptAuthority, unwindowedContextEngineMessagesForPrecheck },
    promptActiveSession,
    stream: { stopAcceptingSteerMessages },
  } = preparedStreamRuntime;
  const { withOwnedTranscriptWrite } = input.sessionLock;
  const withTranscriptWrite = <T>(write: () => Promise<T>) =>
    withOwnedTranscriptWrite(() => withSessionManagerAppend(sessionManager, write));
  const observeForegroundRequests = (
    onRequest: (
      ...args: Parameters<NonNullable<PreparedStreamRuntime["cache"]["onModelRequest"]>>
    ) => void,
  ) => {
    const streamFn = activeSession.agent.streamFn;
    activeSession.agent.streamFn = (model, context, options) => {
      if (!activeSession.isCompacting) {
        onRequest(model, context);
      }
      return streamFn(model, context, options);
    };
  };
  const { diagnosticTrace, runTrace } = input.diagnostics;
  const { systemPromptReport, runtimeInfo } = prepared.systemPrompt;
  let systemPromptText = sessionRuntimeState.systemPromptText;
  const toolSearchCompacted = prepared.toolCatalog.toolSearch.compacted;
  let skipPromptSubmission = false;
  let providerBoundaryPrecheck: MidTurnPrecheckRequest | undefined;
  const providerCompactionAtRequestBoundary = isChatGPTV2CompactionEligible({
    config: attempt.config,
    model: attempt.model,
    extraParams: effectiveExtraParams,
    compactionEnabled,
    compactionReplayEnabled,
    contextEngineOwnsCompaction: activeContextEngine?.info.ownsCompaction,
    operation: attempt.operation,
  });
  const previousThresholdDeferral = activeSession[agentSessionDeferThresholdCompaction];
  if (providerCompactionAtRequestBoundary) {
    activeSession[agentSessionDeferThresholdCompaction] = true;
  }

  const setFailure = (error: unknown, source: AgentRunAttemptFailureSource | null) => {
    input.state.terminal = setAgentRunAttemptTerminalFailure(
      input.state.terminal,
      error !== null && error !== undefined ? { error, source: source ?? "prompt" } : null,
    );
  };
  const publishDispatchState = (state: PromptPreflightState) => {
    skipPromptSubmission = state.skipPromptSubmission;
    promptState.contextBudgetStatus = state.contextBudgetStatus;
    promptState.preflightRecovery = state.preflightRecovery;
    setFailure(state.promptError, state.promptErrorSource);
  };
  const handleMidTurnPrecheckRequest = async (request: MidTurnPrecheckRequest) => {
    const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request,
      sessionAgentId,
      sessionManager,
      toolResultPromptProjectionState,
      prePromptMessageCount: sessionRuntimeState.prePromptMessageCount,
      replaceSessionMessages: (messages) => {
        activeSession.agent.state.messages = messages;
      },
    });
    promptState.preflightRecovery = outcome.preflightRecovery;
    if (outcome.promptError) {
      setFailure(outcome.promptError, "precheck");
    }
  };

  const promptStartedAt = Date.now();

  let transcriptLeafId: string | null = null;
  try {
    const promptAssembly = await prepareEmbeddedAttemptPromptAssembly({
      attempt,
      activeSession,
      sessionManager,
      hookRunner,
      hookAgentId: sessionAgentId,
      diagnosticTrace,
      isRawModelRun,
      ...(orphanRepair ? { orphanRepair } : {}),
      sessionAgentId,
      // A blind child's prompt never names its own model.
      runtimeModel: attempt.blindPrompt ? undefined : runtimeInfo.model,
      systemPromptText,
      runAbortSignal: input.runAbortController.signal,
      hasBaselineTools: promptToolPolicy.hasBaselineTools,
      setActiveSessionSystemPrompt,
      applyPromptBuildToolsAllow: (toolsAllow, pruneForDecision) => {
        // Hook authority follows reachable capabilities, not just provider-visible controls.
        return promptToolPolicy.apply(toolsAllow, pruneForDecision).callableToolNames;
      },
      prepareSystemPrompt: async (currentSystemPrompt) => {
        const refresh = await prepared.systemPrompt.prepareToolPrompt?.(
          promptToolPolicy.current.effectiveTools,
        );
        return refresh ? refresh(currentSystemPrompt) : currentSystemPrompt;
      },
    });
    input.setup.prepStages.mark("prompt-build");
    systemPromptText = sessionRuntimeState.systemPromptText;
    if (prepared.toolCatalog.emptyExplicitToolAllowlistError) {
      setFailure(prepared.toolCatalog.emptyExplicitToolAllowlistError, "precheck");
      skipPromptSubmission = true;
      log.warn(`[tools] ${prepared.toolCatalog.emptyExplicitToolAllowlistError.message}`);
    }
    const { hookCtx, promptBuildPrependContext, promptBuildAppendContext } = promptAssembly;
    transcriptLeafId = promptAssembly.transcriptLeafId;

    const promptContext = await prepareEmbeddedAttemptPromptContext({
      sessionVersion: sessionManager.getHeader()?.version,
      attempt: {
        ...attempt,
        runtimeContextFragments: [
          ...(attempt.runtimeContextFragments ?? []),
          ...(prepared.systemPrompt.runtimeContextFragments ?? []),
        ],
      },
      capabilityToolNames: prepared.toolCatalog.toolSearchRunPlan.capabilityToolNames,
      messages: activeSession.messages,
      prompt: promptAssembly,
      replaceSessionMessages: (messages) => {
        activeSession.agent.state.messages = messages;
      },
      appendOnlyRuntimeContext,
      inHistorySystemUpdates,
      ...(boundaryTimezone ? { boundaryTimezone } : {}),
      includeBoundaryTimestamp,
      isRawModelRun,
      ...(preparedUserTurnMessage ? { preparedUserTurnMessage } : {}),
      sessionAgentId,
      ...(systemPromptReport ? { systemPromptReport } : {}),
      systemPromptText,
      toolResultPromptProjectionState,
    });
    input.setup.prepStages.mark("prompt-context");
    if (runAbortController.signal.aborted) {
      throw createAbortableError(runAbortController.signal);
    }
    promptAssembly.assertHostActive?.();
    const { hookMessagesForCurrentPrompt, promptForModel, systemPromptForHook } = promptContext;
    sessionRuntimeState.prePromptMessageCount = promptContext.prePromptMessageCount;
    setCurrentUserTimestampOverride(promptContext.currentUserTimestampOverride);
    if (attempt.operation !== "settled-tool-finalization") {
      const block = await runBeforeAgentRunGate(
        hookRunner,
        {
          prompt: promptForModel,
          systemPrompt: systemPromptForHook,
          messages: hookMessagesForCurrentPrompt,
          channelId: hookCtx.channelId,
          accountId: attempt.agentAccountId,
          senderId: attempt.senderId ?? undefined,
          senderIsOwner: attempt.senderIsOwner,
        },
        hookCtx,
      );
      if (block) {
        const redactedUserMessage = buildAgentRunBlockedUserMessage(attempt.runId, block);
        if (
          !sessionMessagesContainIdempotencyKey(
            activeSession.messages,
            redactedUserMessage.idempotencyKey,
          )
        ) {
          try {
            await withOwnedTranscriptWrite(() =>
              withSessionManagerAppend(sessionManager, async () => {
                await sessionManager.appendMessageAsync(redactedUserMessage);
                sessionManager.flushPendingPersistence();
              }),
            );
            activeSession.agent.state.messages = sanitizeCompactionReplayMessages(
              sessionManager.buildSessionContext().messages,
            );
          } catch (err) {
            log.warn(
              `before_agent_run block: failed to persist redacted user message: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        input.state.beforeAgentRunBlockedBy = block.blockedBy;
        setFailure(new Error(block.message), "hook:before_agent_run");
        skipPromptSubmission = true;
      }
    }

    if (!skipPromptSubmission) {
      const { resolvedApiKey } = attempt;
      const googlePromptCacheStreamFn = await prepareGooglePromptCacheStreamFn({
        apiKey: await resolveEmbeddedAgentApiKey({
          provider: attempt.provider,
          resolvedApiKey,
          authStorage: attempt.authStorage,
        }),
        extraParams: effectiveExtraParams,
        model: attempt.model,
        modelId: attempt.modelId,
        provider: attempt.provider,
        sessionManager: {
          appendCustomEntryAsync: async (customType, data) => {
            await withTranscriptWrite(async () => {
              runAbortController.signal.throwIfAborted();
              await sessionManager.appendCustomEntryAsync(customType, data);
            });
          },
          getEntries: () => sessionManager.getEntries(),
        },
        signal: runAbortController.signal,
        streamFn: activeSession.agent.streamFn,
      });
      if (googlePromptCacheStreamFn) {
        activeSession.agent.streamFn = googlePromptCacheStreamFn;
      }
    }

    const imageResult = await prepareEmbeddedAttemptPromptExecution({
      mediaOwnerAgentId: sessionAgentId,
      effectiveFsWorkspaceOnly,
      effectiveWorkspace,
      sandbox,
      attempt,
      prompt: promptContext.promptSubmission.prompt,
      skipPromptSubmission,
    });
    const reserveTokens = settingsManager.getCompactionReserveTokens();
    const terminal = projectAgentRunAttemptTerminal(input.state.terminal);
    let state: PromptPreflightState = {
      contextBudgetStatus: promptState.contextBudgetStatus,
      preflightRecovery: promptState.preflightRecovery,
      promptError: terminal.promptError,
      promptErrorSource: terminal.promptErrorSource,
      skipPromptSubmission: observeEmbeddedAttemptPrompt({
        ...promptContext,
        cacheTrace,
        diagnosticTrace,
        hookAgentId: sessionAgentId,
        hookRunner,
        isRawModelRun,
        runTrace,
        streamStrategy,
        systemPromptText,
        toolSearchCompacted,
        trajectoryRecorder,
        transport: effectiveAgentTransport,
        effectiveTools: promptToolPolicy.current.effectiveTools,
        tools: promptToolPolicy.current.tools,
        uncompactedEffectiveTools: promptToolPolicy.current.uncompactedEffectiveTools,
        attempt,
        imageCount: imageResult.images.length,
        reserveTokens,
        sessionMessages: activeSession.messages,
        skipPromptSubmission,
        transcriptLeafId,
      }).skipPromptSubmission,
    };
    // Publish each admission transition before the next fallible phase so outer cleanup sees it.
    publishDispatchState(state);

    let compactionRequestBudget: CompactionRequestBudget | undefined;
    if (!state.skipPromptSubmission) {
      const userTurnRecorder = attempt.userTurnTranscriptRecorder;
      const pendingUserIdempotencyKey =
        attempt.skipPreparedUserTurnMessage !== true && userTurnRecorder?.hasPersisted() === true
          ? (userTurnRecorder.getPersistedMessage?.() ?? userTurnRecorder.message)?.idempotencyKey
          : undefined;
      const foregroundBudget = {
        contextWindow: promptContext.contextTokenBudget,
        reserveTokens,
      };
      const pendingContextMessages = promptContext.runtimeContextMessageForCurrentTurn
        ? [promptContext.runtimeContextMessageForCurrentTurn]
        : [];
      compactionRequestBudget = createCompactionRequestBudget({
        ...foregroundBudget,
        systemPrompt: promptContext.systemPromptForHook,
        tools: activeSession.agent.state.tools,
        pendingPrompt: promptContext.llmBoundaryPromptForPrecheck,
        pendingImageCount: imageResult.images.length,
        // The SDK replaces the queued reservation at submission. Transient
        // installation remains separate because that carrier never enters its queue.
        ...(appendOnlyRuntimeContext ||
        (promptContext.runtimeContextMessageForCurrentTurn &&
          isOpenClawSystemUpdateMessage(promptContext.runtimeContextMessageForCurrentTurn))
          ? {
              pendingQueuedContextMessages: resolvePendingRuntimeContextReplay({
                messages: activeSession.messages,
                pendingContextMessages,
                persistedUserIdempotencyKey: pendingUserIdempotencyKey,
              }).pendingContextMessages,
            }
          : { pendingContextMessages }),
        pendingAdditivePrompt: promptContext.isDispatchedCanonicalFallback
          ? undefined
          : [promptBuildPrependContext, promptBuildAppendContext].filter(Boolean).join("\n\n"),
        pendingUserIdempotencyKey,
      });
      attempt.onCompactionRequestBudget?.(compactionRequestBudget);
      // Summarization has its own prompt/model; it cannot replace foreground accounting.
      observeForegroundRequests((_model, context) => {
        attempt.onCompactionRequestBudget?.(
          createCompactionRequestBudget({
            ...foregroundBudget,
            systemPrompt: context.systemPrompt,
            tools: context.tools,
          }),
        );
      });
    }

    state = await prepareEmbeddedAttemptPromptPreflight({
      appendOnlyRuntimeContext,
      compactionReplayEnabled,
      providerCompactionAtRequestBoundary,
      contextEnginePromptAuthority,
      includeBoundaryTimestamp,
      ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
      ...(unwindowedContextEngineMessagesForPrecheck
        ? { unwindowedContextEngineMessagesForPrecheck }
        : {}),
      attempt,
      contextTokenBudget: promptContext.contextTokenBudget,
      hookMessagesForCurrentPrompt: promptContext.hookMessagesForCurrentPrompt,
      promptForPrecheck: promptContext.llmBoundaryPromptForPrecheck,
      pendingInputTokens: compactionRequestBudget?.pendingTokens,
      reserveTokens,
      sessionMessageCount: activeSession.messages.length,
      state,
      systemPrompt: promptContext.systemPromptForHook,
      toolResultMaxChars: promptContext.promptToolResultMaxChars,
      // Use the installed model-facing tool surface (same source as the compaction
      // request budget) so client tools appended by attempt-client-tools are counted.
      toolSchemaTokens: estimateToolSchemaTokenPressure(activeSession.agent.state.tools),
    });
    input.setup.prepStages.mark("compaction-preflight");
    publishDispatchState(state);

    if (!state.skipPromptSubmission) {
      await submitEmbeddedAttemptPrompt({
        ...(promptBuildAppendContext ? { appendContext: promptBuildAppendContext } : {}),
        attempt,
        registration: preparedStreamRuntime.stream.registration,
        activeSession,
        contextTokenBudget: promptContext.contextTokenBudget,
        compactionRequestBudget,
        ...(providerCompactionAtRequestBoundary
          ? {
              compactBeforeRequest: createChatGPTV2CompactionBoundary({
                session: activeSession,
                config: attempt.config,
                contextTokenBudget: promptContext.contextTokenBudget,
                reserveTokens,
                timeoutMs: input.sessionLock.compactionTimeoutMs,
                authProfileId: attempt.runtimePlan?.auth.forwardedAuthProfileId,
                ...(attempt.sessionKey
                  ? {
                      hookContext: {
                        hookRunner,
                        sessionId: attempt.sessionId,
                        sessionKey: attempt.sessionKey,
                        sessionAgentId,
                        workspaceDir: effectiveWorkspace,
                        messageProvider: attempt.messageProvider,
                        onHookMessages: async ({ phase, messages }) => {
                          const visible = messages.filter((message) => message.trim());
                          if (visible.length) {
                            await attempt.onAgentEvent?.({
                              stream: "compaction",
                              data: {
                                phase: phase === "before" ? "start" : "end",
                                ...(phase === "after" ? { completed: true } : {}),
                                messages: visible,
                              },
                              sessionKey: attempt.sessionKey,
                            });
                          }
                        },
                      },
                    }
                  : {}),
                postCompaction: {
                  config: attempt.config,
                  sessionKey: attempt.sessionKey,
                  sessionId: attempt.sessionId,
                  agentId: sessionAgentId,
                  memoryAudience: attempt.memoryAudience,
                  sandboxed: sandbox?.enabled === true,
                  sessionFile: attempt.sessionFile,
                },
                assertActive: () => {
                  runAbortController.signal.throwIfAborted();
                  promptAssembly.assertHostActive?.();
                },
                withTranscriptWrite,
                onFallback: (request) => {
                  providerBoundaryPrecheck = request;
                },
              }),
            }
          : {}),
        onModelRequest: preparedStreamRuntime.cache.onModelRequest,
        images: imageResult.images,
        modelPrompt: promptContext.promptForModel,
        onFinalPromptText: (prompt) => {
          promptState.finalPromptText = prompt;
        },
        assertHostActive: promptAssembly.assertHostActive,
        withTranscriptWrite,
        getUserTranscriptContexts: sessionRuntime.boundary.getUserTranscriptContexts,
        persistToolResultProjections: async () => {
          if (
            !isRawModelRun &&
            (inHistorySystemUpdates ||
              sessionPromptState.pendingToolSurface ||
              toolResultPromptProjectionState.frozen.size > 0)
          ) {
            await withTranscriptWrite(async () => {
              runAbortController.signal.throwIfAborted();
              await persistToolResultProjections(
                toolResultPromptProjectionState,
                (customType, data) => sessionManager.appendCustomEntryAsync(customType, data),
              );
              const appendEntry = (customType: string, data: unknown) =>
                sessionManager.appendCustomEntryAsync(customType, data);
              await (sessionRuntime.prepareSystemPromptUpdate
                ? persistSessionSystemPrompt(sessionPromptState, appendEntry)
                : persistSessionToolSurface(sessionPromptState, appendEntry));
            });
          }
        },
        ...(promptBuildPrependContext ? { prependContext: promptBuildPrependContext } : {}),
        ...(promptContext.runtimeContextMessageForCurrentTurn
          ? { runtimeContextMessage: promptContext.runtimeContextMessageForCurrentTurn }
          : {}),
        runtimeOnly: promptContext.promptSubmission.runtimeOnly === true,
        setNextUserMessagePersistence: sessionManager.setNextUserMessagePersistence,
        systemPrompt: promptContext.systemPromptForHook,
        toolResultAggregateMaxChars: promptContext.promptToolResultAggregateMaxChars,
        toolResultMaxChars: promptContext.promptToolResultMaxChars,
        transcriptLeafId,
        transcriptPrompt: promptContext.promptForSession,
        appendOnlyRuntimeContext,
        promptActiveSession,
        toolResultPromptProjectionState,
        trajectoryRecorder,
      });
    }
    publishDispatchState(state);
  } catch (error) {
    const promptErrorOutcome = await handleEmbeddedAttemptPromptError({
      activeSession,
      attempt,
      error,
      handleMidTurnPrecheckRequest,
      markYieldAborted: () => {
        promptState.yieldAborted = true;
        input.state.terminal = mergeAgentRunAttemptTerminal(input.state.terminal, {
          kind: "aborted",
          source: "yield_cleanup",
        });
      },
      withOwnedTranscriptWrite,
      ...input.lifecycle.readYieldState(),
    });
    // The timeout owner records its terminal before aborting the prompt. That
    // abort is not a provider failure and must leave timeout salvage eligible.
    if (
      promptErrorOutcome.promptFailure &&
      !(
        projectAgentRunAttemptTerminal(input.state.terminal).timedOutByRunBudget &&
        isOpenClawAbortableWrapper(promptErrorOutcome.promptFailure.error) &&
        promptErrorOutcome.promptFailure.error instanceof Error &&
        promptErrorOutcome.promptFailure.error.cause === runAbortController.signal.reason
      )
    ) {
      setFailure(promptErrorOutcome.promptFailure.error, promptErrorOutcome.promptFailure.source);
    }
  } finally {
    activeSession[agentSessionDeferThresholdCompaction] = previousThresholdDeferral;
    stopAcceptingSteerMessages();
  }

  const pendingMidTurnPrecheckRequest =
    providerBoundaryPrecheck ?? contextGuards.takePendingMidTurnPrecheckRequest();
  if (pendingMidTurnPrecheckRequest) {
    await withTranscriptWrite(async () => {
      await removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
      const terminal = projectAgentRunAttemptTerminal(input.state.terminal);
      if (!promptState.preflightRecovery && terminal.promptErrorSource !== "precheck") {
        setFailure(null, null);
        await handleMidTurnPrecheckRequest(pendingMidTurnPrecheckRequest);
      }
    });
  }

  return { promptStartedAt, transcriptLeafId };
}
