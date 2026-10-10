import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyToolAuthorityPreparation } from "../../../auto-reply/reply/reply-run-registry.contracts.js";
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
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { getModelProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { projectNestedToolActivityForHooks } from "../../../sessions/nested-tool-activity.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { cancelPendingAgentQuestionForSession } from "../../harness/gateway-question.js";
import { runAgentHarnessBeforeAgentFinalizeHook } from "../../harness/lifecycle-hook-helpers.js";
import { bindAgentHarnessHookMessages } from "../../harness/lifecycle-hook-messages.js";
import { resolveReplyExpectation } from "../../reply-completion.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
  isAgentRunRestartAbortReason,
} from "../../run-termination.js";
import type { ToolSearchCatalogToolExecutor } from "../../tool-search.js";
import { isRunnerAbortError } from "../abort.js";
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
import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";
import {
  requiresCompletionRequiredAsyncTaskWait,
  type AsyncStartedToolMeta,
} from "./attempt-async-tasks.js";
import {
  readAttemptNestedToolActivity,
  type AttemptNestedToolActivityState,
} from "./attempt-nested-tool-activity.js";
import {
  claimEmbeddedPendingUserInputAnswer,
  steerActiveSessionWithOptionalDeliveryWait,
} from "./attempt-queue-message.js";
import type { prepareEmbeddedAttemptAgentSession } from "./attempt-session-prepare.js";
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
import { resolveProviderRefusal } from "./provider-refusal.js";
import type { EmbeddedRunAttemptParams, StreamRunState } from "./types.js";

type AttemptStreamQueueHandle = EmbeddedAgentQueueHandle & {
  kind: "embedded";
  cancel: (reason?: "user_abort" | "restart" | "superseded") => void;
};

type PrepareEmbeddedAttemptStreamInput = {
  attempt: EmbeddedRunAttemptInternalParams;
  agentSession: Pick<
    Awaited<ReturnType<typeof prepareEmbeddedAttemptAgentSession>>,
    | "activeSession"
    | "hookRunner"
    | "clientToolCallSlots"
    | "hasDeliveredSourceReply"
    | "markSourceReplyDelivered"
    | "builtinToolNames"
    | "coreBuiltinToolNames"
    | "replaySafeToolNames"
    | "codeModeExecToolNames"
    | "sourceReplyCapableToolNames"
    | "sideEffectToolOwners"
    | "trustedLocalMediaToolNames"
  > &
    Partial<
      Pick<
        Awaited<ReturnType<typeof prepareEmbeddedAttemptAgentSession>>,
        "markCompletedSourceReplyDelivered"
      >
    >;
  applyPermissionMode?: (
    mode: NonNullable<EmbeddedRunAttemptParams["permissionMode"]> | null,
    revokeApprovals: () => void,
  ) => Promise<void>;
  onModelUsage?: Parameters<typeof subscribeEmbeddedAgentSession>[0]["onModelUsage"];
  runtimeChannel?: string;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  nestedToolActivityState: AttemptNestedToolActivityState;
  isReplaySafeTool: (tool: Parameters<ToolSearchCatalogToolExecutor>[0]["tool"]) => boolean;
  runAbortController: AbortController;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  getRunState: () => StreamRunState;
  onBlockReply: EmbeddedRunAttemptParams["onBlockReply"];
  onBlockReplyFlush: EmbeddedRunAttemptParams["onBlockReplyFlush"];
  diagnosticOwner: DiagnosticEmbeddedRunOwner;
  trajectoryRecorder?: Parameters<
    typeof createEmbeddedAttemptDeferredLifecycleOwner
  >[0]["trajectoryRecorder"];
};

export function prepareEmbeddedAttemptStream(input: PrepareEmbeddedAttemptStreamInput) {
  return withEmbeddedAttemptSteeringAdmission(
    input.agentSession.activeSession,
    input.runAbortController.signal,
    (admission) => prepareStream(input, admission),
  );
}

function prepareStream(
  input: PrepareEmbeddedAttemptStreamInput,
  admission: EmbeddedAttemptSteeringAdmission,
) {
  const { attempt, agentSession } = input;
  const { activeSession, hookRunner } = agentSession;
  let beforeAgentFinalizeRevisionReason: string | undefined;
  let beforeAgentFinalizeRevisionEntryId: string | undefined;
  let activeQueueAdmissions = 0;
  const isSteeringAdmissionOpen = () =>
    admission.accepting && !input.getRunState().aborted && !input.runAbortController.signal.aborted;
  const shouldRunBeforeAgentFinalize =
    attempt.operation !== "settled-tool-finalization" &&
    hookRunner?.hasHooks("before_agent_finalize");
  const completionCheck =
    attempt.operation !== "settled-tool-finalization" &&
    !attempt.silentExpected &&
    resolveReplyExpectation(attempt) === "required"
      ? attempt.completionCheck
      : undefined;
  const onBeforeTerminalDelivery: Parameters<
    typeof subscribeEmbeddedAgentSession
  >[0]["onBeforeTerminalDelivery"] =
    shouldRunBeforeAgentFinalize || completionCheck
      ? async (
          event,
        ): Promise<void | { continueCurrentTurn: true } | { suppressTerminalDelivery: true }> => {
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
          const hasCompletedClientToolCall = agentSession.clientToolCallSlots.some(
            (slot) => slot.completed,
          );
          if (
            state.aborted ||
            input.runAbortController.signal.aborted ||
            state.promptError ||
            state.timedOut ||
            hasCompletedClientToolCall ||
            state.yieldDetected ||
            (attempt.silentExpected && isSilentReplyText(lastAssistantMessage, SILENT_REPLY_TOKEN))
          ) {
            return;
          }
          const maxRevisionAttempts = attempt.maxBeforeAgentFinalizeRevisions ?? 0;
          const hookRevisionLimitReached =
            maxRevisionAttempts > 0 &&
            (attempt.beforeAgentFinalizeRevisionAttempts ?? 0) >= maxRevisionAttempts;
          if (shouldRunBeforeAgentFinalize && hookRevisionLimitReached) {
            log.warn(
              `before_agent_finalize revision limit reached; skipping further finalize hooks ` +
                `runId=${attempt.runId} sessionId=${attempt.sessionId} ` +
                `attempts=${attempt.beforeAgentFinalizeRevisionAttempts ?? 0}/${maxRevisionAttempts}`,
            );
          }
          // A queued user message wins over finalization. Close admission before
          // awaiting the hook so no later steer can become a child of the draft.
          admission.accepting = false;
          if (
            activeQueueAdmissions > 0 ||
            activeSession.pendingMessageCount > 0 ||
            activeSession.agent.hasQueuedMessages()
          ) {
            admission.accepting = true;
            return;
          }
          let keepAdmissionClosed = false;
          try {
            let outcome: Awaited<ReturnType<typeof runAgentHarnessBeforeAgentFinalizeHook>> = {
              action: "continue",
            };
            if (shouldRunBeforeAgentFinalize && !hookRevisionLimitReached) {
              const reportedModelRef = resolveReportedModelRef({
                provider: attempt.provider,
                model: attempt.modelId,
                assistant: lastAssistant,
              });
              outcome = await runAgentHarnessBeforeAgentFinalizeHook({
                event: bindAgentHarnessHookMessages(
                  {
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
                    messages: activeSession.messages,
                  },
                  async () => {
                    const activities = await readAttemptNestedToolActivity(
                      activeSession.sessionManager,
                      input.nestedToolActivityState,
                    );
                    if (
                      input.runAbortController.signal.aborted ||
                      input.getRunState().aborted ||
                      admission.closed ||
                      ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) !== queueHandle
                    ) {
                      throw new Error("Nested tool finalization is no longer current");
                    }
                    return projectNestedToolActivityForHooks(activeSession.messages, activities);
                  },
                ),
                ctx: {
                  ...buildEmbeddedAgentHookContext(
                    attempt,
                    input.hookAgentId,
                    freezeDiagnosticTraceContext(input.diagnosticTrace),
                  ),
                  modelProviderId: reportedModelRef.provider,
                  modelId: reportedModelRef.model,
                },
                hookRunner,
              });
            }
            if (outcome.action === "finalize") {
              return;
            }
            if (outcome.action === "revise") {
              if (event.hadDeterministicSideEffect) {
                log.warn(
                  `before_agent_finalize requested revision after potential side effects; not rewinding ` +
                    `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
                );
              } else if (!event.assistantEntryId) {
                log.warn(
                  `before_agent_finalize revision lacks a persisted assistant entry; not rewinding ` +
                    `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
                );
              } else {
                keepAdmissionClosed = true;
                beforeAgentFinalizeRevisionEntryId = event.assistantEntryId;
                beforeAgentFinalizeRevisionReason = outcome.reason;
                return { suppressTerminalDelivery: true };
              }
            }
            const currentState = input.getRunState();
            if (
              !completionCheck?.unfinishedPlan ||
              completionCheck.checked ||
              lastAssistant?.stopReason !== "stop" ||
              resolveProviderRefusal(lastAssistant) ||
              event.hasPendingContinuation ||
              agentSession.hasDeliveredSourceReply() ||
              input.runAbortController.signal.aborted ||
              currentState.aborted ||
              currentState.timedOut ||
              currentState.promptError ||
              currentState.yieldDetected ||
              admission.closed ||
              activeSession.pendingMessageCount > 0 ||
              activeSession.agent.hasQueuedMessages() ||
              !hasCurrentRegistration()
            ) {
              return;
            }
            // This is a same-prompt follow-up, not a replay or draft rewind.
            // Retain every completed effect and consume the check across retries.
            completionCheck.checked = true;
            await activeSession.sendCustomMessage(
              {
                customType: "openclaw.plan-completion-check",
                display: false,
                content: `This run’s latest successfully saved plan still has unfinished steps. Before ending, check whether those steps remain required and authorized under the latest user instructions. Continue feasible work from the current transcript; do not repeat completed actions, and reconcile uncertain effects before retrying. If work is complete, reconcile the plan. If user input, approval, an external dependency, or an explicit pause prevents further work, report that concrete limitation; if your previous reply already reported it, end with only ${SILENT_REPLY_TOKEN}. Do not invent completion or new authority.`,
              },
              { deliverAs: "followUp" },
            );
            return { continueCurrentTurn: true };
          } finally {
            if (!keepAdmissionClosed) {
              admission.accepting = true;
            }
          }
        }
      : undefined;

  const clearActiveRun = () =>
    clearActiveEmbeddedRun(attempt.sessionId, queueHandle, attempt.sessionKey, attempt.sessionFile);
  let toolMetasForTerminal: readonly AsyncStartedToolMeta[] = [];
  // Terminal callbacks run after queue construction; keep the queue in this
  // phase so active-run clearing and subscription teardown share one owner.
  let deferredLifecycleOwner: EmbeddedAttemptDeferredLifecycleOwner | undefined;
  const streamSubscription = subscribeEmbeddedAgentSession({
    // Keep the transcript session key; the sandbox key is only authority context.
    ...attempt,
    ...agentSession,
    session: activeSession,
    onModelUsage: input.onModelUsage,
    messageChannel: input.runtimeChannel,
    hookRunner: getGlobalHookRunner() ?? undefined,
    reasoningMode: attempt.reasoningLevel ?? "off",
    thinkingLevel: attempt.thinkLevel,
    hasDeliveredMessageToolOnlySourceReply: agentSession.hasDeliveredSourceReply,
    onDeliveredMessageToolOnlySourceReply: agentSession.markSourceReplyDelivered,
    onCompletedMessageToolOnlySourceReply: agentSession.markCompletedSourceReplyDelivered,
    trajectoryRecorder: input.trajectoryRecorder,
    onBlockReply: input.onBlockReply,
    onBlockReplyFlush: input.onBlockReplyFlush,
    onBeforeTerminalDelivery,
    deferTerminalDelivery: shouldRunBeforeAgentFinalize === true,
    terminalLifecyclePhase: attempt.deferTerminalLifecycle ? "finishing" : "end",
    isTerminalAborted: () => input.getRunState().aborted,
    resolveTerminalStopReason: () =>
      isAgentRunRestartAbortReason(input.runAbortController.signal.reason)
        ? AGENT_RUN_RESTART_ABORT_STOP_REASON
        : undefined,
    onBeforeLifecycleTerminal: async () => {
      if (deferredLifecycleOwner) {
        return;
      }
      let requiresTaskWait = false;
      try {
        requiresTaskWait = requiresCompletionRequiredAsyncTaskWait({
          sessionKey: attempt.sessionKey,
          toolMetas: toolMetasForTerminal,
          abortSignal: input.runAbortController.signal,
        });
      } catch (error) {
        if (!input.runAbortController.signal.aborted || !isRunnerAbortError(error)) {
          throw error;
        }
        // Cancelling this observation must not defer cleanup past the terminal event.
      }
      if (deferredLifecycleOwner || requiresTaskWait) {
        return;
      }
      // Clear active-run state before terminal events and post-completion cleanup.
      clearActiveRun();
    },
    providerOwner: getModelProviderRuntimePluginHandle(attempt.model)?.plugin,
    currentAccountId: attempt.agentAccountId,
    currentThreadId: attempt.currentThreadTs,
    agentId: input.hookAgentId,
  });
  const unsubscribe = admission.bindStreamUnsubscribe(streamSubscription.unsubscribe);
  const subscription = { ...streamSubscription, unsubscribe };
  toolMetasForTerminal = subscription.toolMetas;

  const toolSearchCatalogExecutor = createSubscribedToolSearchExecutor({
    attempt,
    runSignal: input.runAbortController.signal,
    sessionManager: activeSession.sessionManager,
    subscription,
    isCurrent: () =>
      ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) === queueHandle && !input.getRunState().aborted,
    isReplaySafeTool: input.isReplaySafeTool,
    nestedToolActivityState: input.nestedToolActivityState,
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
  const hasCurrentRegistration = () => {
    // The session awaits transcript/question preparation after the global queue
    // check. Revalidate this exact publication and its live scope at the effect.
    registration?.toolAuthority?.assertActive();
    return (
      registration !== undefined &&
      ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(queueHandle) === registration &&
      ACTIVE_EMBEDDED_RUNS.get(attempt.sessionId) === queueHandle &&
      ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(attempt.runId) === queueHandle
    );
  };
  const canInject = () => isSteeringAdmissionOpen() && hasCurrentRegistration();
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
    toolAuthorityPreparation?: ReplyToolAuthorityPreparation,
  ): InputAuthority => ({
    kind,
    toolAuthorityPreparation,
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
    prepareCurrent?: () => Promise<void>,
    toolAuthorityPreparation?: ReplyToolAuthorityPreparation,
  ) => {
    const canInjectMessage = composeInjectionGuard(assertCurrent);
    if (!canInjectMessage()) {
      throw new Error("active session is finalizing");
    }
    activeQueueAdmissions++;
    try {
      if (options?.steeringMode) {
        activeSession.agent.steeringMode = options.steeringMode;
      }
      return await steerActiveSessionWithOptionalDeliveryWait(
        activeSession,
        text,
        options,
        attempt.sessionKey,
        canInjectMessage,
        questionAuthority(assertCurrent, authorityKind, toolAuthorityPreparation),
        prepareCurrent,
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
    preparation?: ReplyToolAuthorityPreparation,
  ) =>
    claimEmbeddedPendingUserInputAnswer(
      text,
      options,
      attempt.sessionKey,
      composeInjectionGuard(assertCurrent),
      questionAuthority(assertCurrent, authorityKind, preparation),
    );
  const cancelPendingUserInput = (
    resolvedBy: string,
    assertCurrent?: () => void,
    authorityKind: InputAuthority["kind"] = assertCurrent ? "source-bound" : "run",
    preparation?: ReplyToolAuthorityPreparation,
  ) =>
    cancelPendingAgentQuestionForSession({
      sessionKey: attempt.sessionKey,
      resolvedBy,
      authority: questionAuthority(assertCurrent, authorityKind, preparation),
    });
  const messageInjection = {
    version: 2 as const,
    isAvailable: isSteeringAdmissionOpen,
    queueMessage,
    claimPendingUserInputAnswer,
    cancelPendingUserInput,
    queueMessageAsync: (text, options, preparation, kind) =>
      queueMessage(
        text,
        options,
        preparation.assertCurrent,
        kind,
        preparation.prepareCurrent,
        preparation,
      ),
    claimPendingUserInputAnswerAsync: (text, options, preparation, kind) =>
      claimPendingUserInputAnswer(text, options, preparation.assertCurrent, kind, preparation),
    cancelPendingUserInputAsync: (resolvedBy, preparation, kind) =>
      cancelPendingUserInput(resolvedBy, preparation.assertCurrent, kind, preparation),
  } satisfies NonNullable<EmbeddedAgentQueueHandle["messageInjectionV2"]>;
  const heartbeatReplyOperation =
    attempt.replyOperation?.turnKind === "heartbeat" ? attempt.replyOperation : undefined;
  const canApplyPermissionMode = () =>
    admission.accepting &&
    !input.runAbortController.signal.aborted &&
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(attempt.runId) === queueHandle;
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
          if (!canApplyPermissionMode()) {
            return false;
          }
          if ((attempt.permissionMode ?? null) === mode) {
            return true;
          }
          try {
            await applyPermissionMode(mode, revokeApprovals);
            return canApplyPermissionMode();
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
    isStreaming: () => activeSession.isStreaming,
    isAborted: () => input.getRunState().aborted,
    isStopped: () => !isSteeringAdmissionOpen(),
    isCompacting: () => subscription.isCompacting(),
    supportsTranscriptCommitWait: true,
    supportsQueueMessageImages: true,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    terminalReplyExpectation: resolveReplyExpectation(attempt),
    taskSuggestionDeliveryMode: attempt.taskSuggestionDeliveryMode,
    cancel: abortActiveRunExternally,
    abort: abortActiveRunExternally,
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
          clearActiveRun();
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
