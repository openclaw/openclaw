/**
 * Prepares stream subscription, tool execution, and the active run queue.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { captureAgentRunLifecycleGeneration } from "../../../infra/agent-events.js";
import { validateAgentRunDelegatedAuthority } from "../../../infra/agent-run-registry.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
} from "../../../logging/diagnostic-run-activity.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { getModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import {
  projectNestedToolActivityForHooks,
  type NestedToolActivity,
} from "../../../sessions/nested-tool-activity.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { cancelPendingAgentQuestionForSession } from "../../harness/gateway-question.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../harness/lifecycle-hook-helpers.js";
import { resolveReplyExpectation } from "../../reply-completion.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  isAgentRunRestartAbortReason,
} from "../../run-termination.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession } from "../../sessions/index.js";
import type { ToolSearchCatalogToolExecutor } from "../../tool-search.js";
import { log } from "../logger.js";
import {
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  setActiveEmbeddedRunLifecycleGeneration,
} from "../run-state.js";
import {
  clearActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
  setActiveEmbeddedRun,
} from "../runs.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  type AsyncStartedToolMeta,
} from "./attempt-async-tasks.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "./attempt-queue-message.js";
import {
  withEmbeddedAttemptSteeringAdmission,
  type EmbeddedAttemptSteeringAdmission,
} from "./attempt-steering-admission.js";
import { createSubscribedToolSearchExecutor } from "./attempt-tool-search-executor.js";
import {
  createEmbeddedAttemptDeferredLifecycleOwner,
  type EmbeddedAttemptDeferredLifecycleOwner,
} from "./deferred-lifecycle-owner.js";
import {
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveReportedModelRef,
} from "./helpers.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import type {
  EmbeddedAttemptClientToolCallSlot,
  EmbeddedRunAttemptParams,
  StreamRunState,
} from "./types.js";

type HookRunner = ReturnType<typeof getGlobalHookRunner>;

type AttemptStreamQueueHandle = EmbeddedAgentQueueHandle & {
  kind: "embedded";
  cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
};

type PrepareEmbeddedAttemptStreamInput = {
  attempt: EmbeddedRunAttemptInternalParams;
  applyPermissionMode?: (
    mode: NonNullable<EmbeddedRunAttemptParams["permissionMode"]> | null,
    revokeApprovals: () => void,
  ) => void;
  activeSession: AgentSession;
  onModelUsage?: Parameters<typeof subscribeEmbeddedAgentSession>[0]["onModelUsage"];
  runtimeChannel?: string;
  hookRunner: HookRunner;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  clientToolCallSlots: readonly EmbeddedAttemptClientToolCallSlot[];
  nestedToolActivities: NestedToolActivity[];
  isReplaySafeTool: (tool: Parameters<ToolSearchCatalogToolExecutor>[0]["tool"]) => boolean;
  runAbortController: AbortController;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  getRunState: () => StreamRunState;
  hasDeliveredSourceReply: () => boolean;
  markSourceReplyDelivered: () => void;
  onBlockReply: EmbeddedRunAttemptParams["onBlockReply"];
  onBlockReplyFlush: EmbeddedRunAttemptParams["onBlockReplyFlush"];
  sandboxSessionKey: string;
  builtinToolNames: ReadonlySet<string>;
  coreBuiltinToolNames?: ReadonlySet<string>;
  replaySafeToolNames: ReadonlySet<string>;
  codeModeExecToolNames?: ReadonlySet<string>;
  sideEffectToolOwners?: ReadonlyMap<string, string>;
  trustedLocalMediaToolNames: ReadonlySet<string>;
  diagnosticOwner: DiagnosticEmbeddedRunOwner;
  trajectoryRecorder?: Parameters<
    typeof createEmbeddedAttemptDeferredLifecycleOwner
  >[0]["trajectoryRecorder"];
};

export function prepareEmbeddedAttemptStream(input: PrepareEmbeddedAttemptStreamInput) {
  return withEmbeddedAttemptSteeringAdmission(
    input.activeSession,
    input.runAbortController.signal,
    (admission) => prepareStream(input, admission),
  );
}

function prepareStream(
  input: PrepareEmbeddedAttemptStreamInput,
  admission: EmbeddedAttemptSteeringAdmission,
) {
  const { attempt, hookRunner } = input;
  let beforeAgentFinalizeRevisionReason: string | undefined;
  let beforeAgentFinalizeRevisionEntryId: string | undefined;
  let activeQueueAdmissions = 0;
  const isSteeringAdmissionOpen = () =>
    admission.accepting && !input.getRunState().aborted && !input.runAbortController.signal.aborted;
  const shouldRunBeforeAgentFinalize =
    attempt.operation !== "settled-tool-finalization" &&
    hookRunner?.hasHooks("before_agent_finalize");
  const onBeforeTerminalDelivery = shouldRunBeforeAgentFinalize
    ? async (event: {
        messages: AgentMessage[];
        willRetry: boolean;
        assistantEntryId?: string;
        lastAssistant?: AgentMessage;
        assistantTexts: readonly string[];
        hasAssistantVisibleText: boolean;
        isError: boolean;
        incompleteTerminalAssistant: boolean;
        hadDeterministicSideEffect: boolean;
      }): Promise<void | { suppressTerminalDelivery: true }> => {
        if (
          beforeAgentFinalizeRevisionReason ||
          event.willRetry ||
          event.isError ||
          event.incompleteTerminalAssistant ||
          !event.hasAssistantVisibleText
        ) {
          return;
        }
        const lastAssistant = event.lastAssistant as AssistantMessage | undefined;
        const lastAssistantMessage =
          normalizeOptionalString(resolveFinalAssistantVisibleText(lastAssistant)) ??
          normalizeOptionalString(resolveFinalAssistantRawText(lastAssistant)) ??
          normalizeOptionalString(event.assistantTexts.join("\n\n"));
        if (!lastAssistantMessage) {
          return;
        }
        const state = input.getRunState();
        const hasCompletedClientToolCall = input.clientToolCallSlots.some((slot) => slot.completed);
        if (
          state.aborted ||
          state.promptError ||
          state.timedOut ||
          hasCompletedClientToolCall ||
          state.yieldDetected ||
          (attempt.silentExpected && isSilentReplyText(lastAssistantMessage, SILENT_REPLY_TOKEN))
        ) {
          return;
        }
        const hookMessages = projectNestedToolActivityForHooks(
          input.activeSession.messages,
          input.nestedToolActivities,
        );
        const reportedModelRef = resolveReportedModelRef({
          provider: attempt.provider,
          model: attempt.modelId,
          assistant: lastAssistant,
        });
        const maxRevisionAttempts = attempt.maxBeforeAgentFinalizeRevisions ?? 0;
        if (
          maxRevisionAttempts > 0 &&
          (attempt.beforeAgentFinalizeRevisionAttempts ?? 0) >= maxRevisionAttempts
        ) {
          log.warn(
            `before_agent_finalize revision limit reached; finalizing ` +
              `runId=${attempt.runId} sessionId=${attempt.sessionId} ` +
              `attempts=${attempt.beforeAgentFinalizeRevisionAttempts ?? 0}/${maxRevisionAttempts}`,
          );
          return;
        }
        // A queued user message wins over finalization. Close admission before
        // awaiting the hook so no later steer can become a child of the draft.
        admission.accepting = false;
        if (
          activeQueueAdmissions > 0 ||
          input.activeSession.pendingMessageCount > 0 ||
          input.activeSession.agent.hasQueuedMessages()
        ) {
          admission.accepting = true;
          return;
        }
        let keepAdmissionClosed = false;
        try {
          const outcome = await runAgentHarnessBeforeAgentFinalizeHook({
            event: {
              runId: attempt.runId,
              sessionId: attempt.sessionId,
              ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
              provider: reportedModelRef.provider,
              model: reportedModelRef.model,
              ...((attempt.cwd ?? attempt.workspaceDir)
                ? { cwd: attempt.cwd ?? attempt.workspaceDir }
                : {}),
              ...(attempt.sessionFile ? { transcriptPath: attempt.sessionFile } : {}),
              stopHookActive: false,
              lastAssistantMessage,
              messages: hookMessages,
            },
            ctx: {
              runId: attempt.runId,
              trace: freezeDiagnosticTraceContext(input.diagnosticTrace),
              agentId: input.hookAgentId,
              sessionKey: attempt.sessionKey,
              sessionId: attempt.sessionId,
              workspaceDir: attempt.workspaceDir,
              modelProviderId: reportedModelRef.provider,
              modelId: reportedModelRef.model,
              trigger: attempt.trigger,
              ...buildAgentHookContextChannelFields(attempt),
              ...buildAgentHookContextIdentityFields({
                trigger: attempt.trigger,
                senderId: attempt.senderId,
                chatId: attempt.chatId,
                channelContext: attempt.channelContext,
              }),
            },
            hookRunner,
          });
          if (outcome.action !== "revise") {
            return;
          }
          if (event.hadDeterministicSideEffect) {
            log.warn(
              `before_agent_finalize requested revision after potential side effects; finalizing ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
            );
            return;
          }
          if (!event.assistantEntryId) {
            log.warn(
              `before_agent_finalize revision lacks a persisted assistant entry; finalizing ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
            );
            return;
          }
          keepAdmissionClosed = true;
          beforeAgentFinalizeRevisionEntryId = event.assistantEntryId;
          beforeAgentFinalizeRevisionReason = outcome.reason;
          return { suppressTerminalDelivery: true };
        } finally {
          if (!keepAdmissionClosed) {
            admission.accepting = true;
          }
        }
      }
    : undefined;

  let toolMetasForTerminal: readonly AsyncStartedToolMeta[] = [];
  // Terminal callbacks run after queue construction; keep the queue in this
  // phase so active-run clearing and subscription teardown share one owner.
  let deferredLifecycleOwner: EmbeddedAttemptDeferredLifecycleOwner | undefined;
  const streamSubscription = subscribeEmbeddedAgentSession({
    session: input.activeSession,
    onModelUsage: input.onModelUsage,
    runId: attempt.runId,
    lifecycleGeneration: attempt.lifecycleGeneration,
    messageChannel: input.runtimeChannel,
    initialReplayState: attempt.initialReplayState,
    assistantErrorTranscript: attempt.assistantErrorTranscript,
    hookRunner: getGlobalHookRunner() ?? undefined,
    verboseLevel: attempt.verboseLevel,
    reasoningMode: attempt.reasoningLevel ?? "off",
    thinkingLevel: attempt.thinkLevel,
    toolResultFormat: attempt.toolResultFormat,
    toolProgressDetail: attempt.toolProgressDetail,
    shouldEmitToolResult: attempt.shouldEmitToolResult,
    shouldEmitToolOutput: attempt.shouldEmitToolOutput,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    hasDeliveredMessageToolOnlySourceReply: input.hasDeliveredSourceReply,
    onDeliveredMessageToolOnlySourceReply: input.markSourceReplyDelivered,
    onAgentToolResult: attempt.onAgentToolResult,
    observeToolTerminal: attempt.observeToolTerminal,
    trajectoryRecorder: input.trajectoryRecorder,
    onToolResult: attempt.onToolResult,
    onReasoningStream: attempt.onReasoningStream,
    streamReasoningInNonStreamModes: attempt.streamReasoningInNonStreamModes,
    onReasoningEnd: attempt.onReasoningEnd,
    onBlockReply: input.onBlockReply,
    onBlockReplyFlush: input.onBlockReplyFlush,
    onBeforeTerminalDelivery,
    blockReplyBreak: attempt.blockReplyBreak,
    blockReplyChunking: attempt.blockReplyChunking,
    onPartialReply: attempt.onPartialReply,
    onAssistantMessageStart: attempt.onAssistantMessageStart,
    onExecutionPhase: attempt.onExecutionPhase,
    onAgentEvent: attempt.onAgentEvent,
    terminalLifecyclePhase: attempt.deferTerminalLifecycle ? "finishing" : "end",
    onToolStreamBoundary: attempt.onToolStreamBoundary,
    isTerminalAborted: () => input.getRunState().aborted,
    resolveTerminalStopReason: () =>
      isAgentRunRestartAbortReason(input.runAbortController.signal.reason)
        ? AGENT_RUN_RESTART_ABORT_STOP_REASON
        : undefined,
    onBeforeLifecycleTerminal: () => {
      if (
        deferredLifecycleOwner ||
        requiresCompletionRequiredAsyncTaskWait({
          sessionKey: attempt.sessionKey,
          toolMetas: toolMetasForTerminal,
        })
      ) {
        return;
      }
      // Clear active-run state before terminal events and post-completion cleanup.
      clearActiveEmbeddedRun(
        attempt.sessionId,
        queueHandle,
        attempt.sessionKey,
        attempt.sessionFile,
      );
    },
    enforceFinalTag: attempt.enforceFinalTag,
    silentExpected: attempt.silentExpected,
    suppressLiveStreamOutput: attempt.suppressLiveStreamOutput,
    config: attempt.config,
    providerOwner: getModelProviderRuntimePluginHandle(attempt.model)?.plugin,
    compactionCountOwner: attempt.compactionCountOwner,
    onContextAccountingEvent: attempt.onContextAccountingEvent,
    sessionPersistence: attempt.sessionPersistence,
    // Live events belong to the transcript session. The sandbox key is only
    // authority context and may intentionally point at a visible parent.
    sessionKey: attempt.sessionKey,
    currentChannelId: attempt.currentChannelId,
    currentMessagingTarget: attempt.currentMessagingTarget,
    currentAccountId: attempt.agentAccountId,
    currentThreadId: attempt.currentThreadTs,
    currentMessageId: attempt.currentMessageId,
    replyToMode: attempt.replyToMode,
    hasRepliedRef: attempt.hasRepliedRef,
    sessionId: attempt.sessionId,
    agentId: input.hookAgentId,
    builtinToolNames: input.builtinToolNames,
    coreBuiltinToolNames: input.coreBuiltinToolNames,
    replaySafeToolNames: input.replaySafeToolNames,
    ...(input.codeModeExecToolNames ? { codeModeExecToolNames: input.codeModeExecToolNames } : {}),
    ...(input.sideEffectToolOwners ? { sideEffectToolOwners: input.sideEffectToolOwners } : {}),
    trustedLocalMediaToolNames: input.trustedLocalMediaToolNames,
    internalEvents: attempt.internalEvents,
  });
  const unsubscribe = admission.bindStreamUnsubscribe(streamSubscription.unsubscribe);
  const subscription = { ...streamSubscription, unsubscribe };
  toolMetasForTerminal = subscription.toolMetas;

  const toolSearchCatalogExecutor = createSubscribedToolSearchExecutor({
    attempt,
    runSignal: input.runAbortController.signal,
    sessionManager: input.activeSession.sessionManager,
    subscription,
    isCurrent: () =>
      ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) === queueHandle && !input.getRunState().aborted,
    isReplaySafeTool: input.isReplaySafeTool,
    nestedToolActivities: input.nestedToolActivities,
  });

  let externalAbortAccepted = false;
  const abortActiveRunExternally = (reason?: "user_abort" | "restart" | "superseded") => {
    // Reply cancellation can synchronously re-enter through this same backend.
    // Latch before callbacks so the first reason owns every abort side effect.
    if (externalAbortAccepted) {
      return;
    }
    externalAbortAccepted = true;
    input.markExternalAbort();
    attempt.onDeferredLifecycleAbort?.(reason);
    attempt.onAttemptAbort?.();
    const abortReason =
      reason === "restart"
        ? createAgentRunRestartAbortError()
        : reason === "superseded"
          ? createAgentRunSupersededAbortError()
          : undefined;
    input.abortRun(false, abortReason);
  };
  const canInject = () => {
    // The session awaits transcript/question preparation after the global queue
    // check. Revalidate this exact publication and its live scope at the effect.
    registration?.toolAuthority?.assertActive();
    return (
      isSteeringAdmissionOpen() &&
      registration !== undefined &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(queueHandle) === registration &&
      ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) === queueHandle &&
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(attempt.runId) === queueHandle
    );
  };
  type InputAuthority = NonNullable<
    Parameters<typeof cancelPendingAgentQuestionForSession>[0]["authority"]
  >;
  const composeInjectionGuard = (assertCurrent?: () => void) => () => {
    assertCurrent?.();
    return canInject();
  };
  const questionAuthority = (
    assertCurrent: (() => void) | undefined,
    kind: InputAuthority["kind"],
  ): InputAuthority => ({
    kind,
    assertCurrent: () => {
      if (!composeInjectionGuard(assertCurrent)()) {
        throw new Error("active session is finalizing");
      }
    },
  });
  // The shipped V1 entry retains backend-only authority; V2 requires the host assertion.
  const queueMessage = async (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) => {
    const canInjectMessage = composeInjectionGuard(assertCurrent);
    if (!canInjectMessage()) {
      throw new Error("active session is finalizing");
    }
    activeQueueAdmissions++;
    try {
      if (options?.steeringMode) {
        input.activeSession.agent.steeringMode = options.steeringMode;
      }
      return await steerActiveSessionWithOptionalDeliveryWait(
        input.activeSession,
        text,
        options,
        attempt.sessionKey,
        canInjectMessage,
        questionAuthority(assertCurrent, authorityKind),
      );
    } finally {
      activeQueueAdmissions--;
    }
  };
  const claimPendingUserInputAnswer = (
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) =>
    claimEmbeddedPendingUserInputAnswer(
      text,
      options,
      attempt.sessionKey,
      composeInjectionGuard(assertCurrent),
      questionAuthority(assertCurrent, authorityKind),
    );
  const cancelPendingUserInput = (
    resolvedBy: string,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
  ) =>
    cancelPendingAgentQuestionForSession({
      sessionKey: attempt.sessionKey,
      resolvedBy,
      authority: questionAuthority(assertCurrent, authorityKind),
    });
  const messageInjection = {
    version: 2 as const,
    isAvailable: isSteeringAdmissionOpen,
    queueMessage,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
  };
  const heartbeatReplyOperation =
    attempt.replyOperation?.turnKind === "heartbeat" ? attempt.replyOperation : undefined;
  const applyPermissionMode = input.applyPermissionMode;
  const queueHandle: AttemptStreamQueueHandle = {
    kind: "embedded",
    runId: attempt.runId,
    permissionChangeOwner: attempt.permissionChange?.owner,
    diagnosticOwner: input.diagnosticOwner,
    closeDiagnostics: () => closeDiagnosticEmbeddedRunOwner(input.diagnosticOwner),
    startedAtMs: attempt.startedAtMs,
    get toolAuthorityFingerprint() {
      return attempt.toolAuthorityFingerprint;
    },
    applyPermissionMode: applyPermissionMode
      ? async (mode, revokeApprovals) => {
          if (
            !admission.accepting ||
            input.runAbortController.signal.aborted ||
            ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(attempt.runId) !== queueHandle
          ) {
            return false;
          }
          if ((attempt.permissionMode ?? null) === mode) {
            return true;
          }
          try {
            applyPermissionMode(mode, revokeApprovals);
            return true;
          } catch (error) {
            // A partially rebuilt surface must never resume its revoked tools.
            input.abortRun(false, error);
            throw error;
          }
        }
      : undefined,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
    preemptByVisibleTurn: heartbeatReplyOperation
      ? () => heartbeatReplyOperation.supersede()
      : undefined,
    queueMessage,
    messageInjection,
    messageInjectionV2: messageInjection,
    isStreaming: () => input.activeSession.isStreaming,
    isAborted: () => input.getRunState().aborted,
    isStopped: () => !isSteeringAdmissionOpen(),
    isCompacting: () => subscription.isCompacting(),
    supportsTranscriptCommitWait: true,
    supportsQueueMessageImages: true,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    terminalReplyExpectation: resolveReplyExpectation(attempt),
    taskSuggestionDeliveryMode: attempt.taskSuggestionDeliveryMode,
    cancel: abortActiveRunExternally,
    abort: (reason) => abortActiveRunExternally(reason),
  };
  attempt.replyOperation?.attachBackend(queueHandle);
  setActiveEmbeddedRunLifecycleGeneration(
    queueHandle,
    attempt.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(attempt.runId),
  );
  setActiveEmbeddedRun(
    attempt.sessionId,
    queueHandle,
    attempt.sessionKey,
    attempt.sessionFile,
    input.hookAgentId,
  );
  const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(queueHandle);
  if (attempt.deferTerminalLifecycle && attempt.onDeferredLifecycleOwner) {
    deferredLifecycleOwner = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: attempt.runId,
      sessionId: attempt.sessionId,
      diagnosticOwner: input.diagnosticOwner,
      onRetryWaitCompleted: () => attempt.replyOperation?.recordActivity(),
      isCurrent: () =>
        registration?.delegatedAuthority !== undefined &&
        validateAgentRunDelegatedAuthority(registration.delegatedAuthority) &&
        ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(queueHandle) === registration &&
        ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) === queueHandle,
      trajectoryRecorder: input.trajectoryRecorder ?? null,
      clearActiveRun: () => {
        try {
          unsubscribe();
        } finally {
          clearActiveEmbeddedRun(
            attempt.sessionId,
            queueHandle,
            attempt.sessionKey,
            attempt.sessionFile,
          );
        }
      },
    });
    try {
      attempt.onDeferredLifecycleOwner(deferredLifecycleOwner);
    } catch (error) {
      deferredLifecycleOwner.discard();
      throw error;
    }
  }

  return {
    subscription,
    queueHandle,
    deferredLifecycleOwner,
    toolSearchCatalogExecutor,
    getBeforeAgentFinalizeRevisionReason: () => beforeAgentFinalizeRevisionReason,
    getBeforeAgentFinalizeRevisionEntryId: () => beforeAgentFinalizeRevisionEntryId,
    stopAcceptingSteerMessages: admission.stop,
  };
}
