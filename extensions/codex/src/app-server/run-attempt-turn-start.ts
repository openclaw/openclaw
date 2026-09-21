import {
  embeddedAgentLog,
  formatErrorMessage,
  runAgentHarnessBeforeAgentRun,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { classifyCodexModelCallFailureKind } from "./attempt-diagnostics.js";
import {
  buildCodexTurnStartFailureResult,
  isInvalidCodexImagePayloadError,
} from "./attempt-results.js";
import { isCodexContextRestartSelectionChangedError } from "./attempt-startup.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { emitCodexAppServerEvent, runCodexAgentEndHook } from "./run-attempt-lifecycle.js";
import type { CodexAttemptNotificationController } from "./run-attempt-notification-controller.js";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import {
  isCodexActiveCompactTurnError,
  clearCodexBindingAfterInvalidImagePayload,
  shouldUseFreshCodexThreadAfterContextEngineOverflow,
} from "./run-attempt-state.js";
import type {
  CodexStartedTurn,
  prepareCodexAttemptTurnRequest,
} from "./run-attempt-turn-request.js";
import type { CodexAttemptTurnState } from "./run-attempt-turn-state.js";
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";
import { buildCodexUserPromptMessage } from "./transcript-mirror.js";
import {
  CodexUsageLimitPromptError,
  formatCodexTurnStartUsageLimitError,
  markCodexAuthProfileBlockedFromRateLimits,
} from "./usage-limit-error.js";

export async function startCodexAttemptTurn(
  resources: CodexAttemptResources,
  turnRuntime: CodexAttemptTurnState,
  notifications: CodexAttemptNotificationController,
  requestRuntime: Awaited<ReturnType<typeof prepareCodexAttemptTurnRequest>>,
): Promise<{ result: EmbeddedRunAttemptResult } | CodexStartedTurn> {
  const { prompt, state: resourceState, trajectoryRecorder, markTrajectoryEndRecorded } = resources;
  const { context, turnState, systemPromptReport } = prompt;
  const { runtime, historyState, hookContext, hookContextWindowFields, hookRunner } = context;
  const { connection, runtimeParams, effectiveRuntimeProviderId, effectiveRuntimeModelId } =
    runtime;
  const {
    params,
    usesSupervisionConnection,
    runAbortController,
    activeContextEngine,
    bindingStore,
    bindingIdentity,
    appServer,
    attemptStartedAt,
    startupAuthProfileId,
  } = connection;
  const { state, turnIdRef } = turnRuntime;
  const { waitForActiveNativeTurnCompletion } = notifications;
  const { codexModelCallDiagnostics, startCodexTurn, buildLlmInputEvent } = requestRuntime;

  // Admission runs exactly once per attempt, before diagnostics, llm_input, or
  // any native turn/start call. The compact-turn and fresh-thread recoveries
  // below retry startCodexTurn() within this same function call; they reuse
  // this one decision and never re-enter the gate.
  const llmInputEvent = buildLlmInputEvent();
  // Only pay for the history snapshot (and its deep clone) when a policy is
  // actually registered to see it; runAgentHarnessBeforeAgentRun resolves
  // "pass" without inspecting the event otherwise, but its argument is built
  // eagerly by this caller regardless.
  const hasBeforeAgentRunHook = hookRunner?.hasHooks("before_agent_run") ?? false;
  const admission = await runAgentHarnessBeforeAgentRun({
    event: {
      prompt: llmInputEvent.prompt,
      // An isolated snapshot of the loaded session history, not the
      // llm_input event's historyMessages field: Codex's llm_input payload
      // intentionally omits history that native app-server already holds
      // (see run-attempt.hooks.test.ts), while a before_agent_run policy
      // needs the actual loaded history to make history-dependent decisions.
      // Deep-clone each message so a hook cannot mutate the attempt's shared
      // state through nested content objects, matching the canonical
      // embedded-runner isolation (runEmbeddedAttemptBeforeAgentRun).
      messages: hasBeforeAgentRunHook
        ? historyState.messages.map((message) => structuredClone(message))
        : [],
      systemPrompt: llmInputEvent.systemPrompt,
      accountId: params.agentAccountId ?? undefined,
      // The canonical per-conversation identity: derived from the session key
      // and channel/thread metadata, not just the messaging channel/provider
      // pair (which two distinct conversations on the same provider share).
      channelId: hookContext.channelId,
      senderId: params.senderId ?? undefined,
      senderIsOwner: params.senderIsOwner ?? undefined,
    },
    ctx: hookContext,
    hookRunner,
  });
  // A cancellation that races with the admission call must win outright: do
  // not act on a pass or a block decision computed for an attempt the caller
  // already abandoned, and never start a native turn for it.
  runAbortController.signal.throwIfAborted();
  if (admission.outcome === "block") {
    void emitCodexAppServerEvent(params, {
      stream: "codex_app_server.lifecycle",
      data: { phase: "turn_start_blocked", error: admission.message },
    });
    // Replace the rejected prompt with a redacted placeholder before it ever
    // reaches the transcript owner, the agent_end hook, or the returned
    // snapshot. The original prompt text must not escape a blocked attempt.
    const blockedAt = Date.now();
    const redactedUserMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: admission.message }],
      timestamp: blockedAt,
      idempotencyKey: `hook-block:before_agent_run:user:${params.runId}`,
      __openclaw: {
        beforeAgentRunBlocked: { blockedBy: admission.blockedBy, blockedAt },
      },
    };
    try {
      await runtimeParams.userTurnTranscriptRecorder?.persistBlocked(redactedUserMessage);
    } catch (persistError) {
      embeddedAgentLog.warn(
        "codex app-server before_agent_run block: failed to persist redacted user message",
        { error: formatErrorMessage(persistError) },
      );
    }
    const messagesSnapshot = [...historyState.messages, redactedUserMessage];
    await runCodexAgentEndHook(params, {
      event: {
        messages: messagesSnapshot,
        success: false,
        error: admission.message,
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookContext,
      hookRunner,
    });
    return {
      result: buildCodexTurnStartFailureResult({
        params,
        message: admission.message,
        messagesSnapshot,
        systemPromptReport,
        promptErrorSource: "hook:before_agent_run",
      }),
    };
  }

  let started: CodexStartedTurn | undefined;
  // From this point, failure may include an accepted native write. Never return
  // the warm claim idle merely because active-turn setup did not complete.
  resourceState.turnStartAttempted = true;
  try {
    codexModelCallDiagnostics.emitStarted();
    runAgentHarnessLlmInputHook({ event: llmInputEvent, ctx: hookContext, hookRunner });
    started = await startCodexTurn();
  } catch (error) {
    let turnStartError = error;
    if (isCodexActiveCompactTurnError(turnStartError)) {
      embeddedAgentLog.info(
        "codex app-server turn/start blocked by active compact turn; waiting to retry",
        { threadId: resourceState.thread.threadId },
      );
      const compactTurnCompleted = await waitForActiveNativeTurnCompletion();
      if (compactTurnCompleted && !runAbortController.signal.aborted) {
        void emitCodexAppServerEvent(params, {
          stream: "codex_app_server.lifecycle",
          data: {
            phase: "turn_start_retry_after_compact",
            threadId: resourceState.thread.threadId,
          },
        });
        try {
          started = await startCodexTurn();
        } catch (retryError) {
          turnStartError = retryError;
        }
      }
    }
    if (
      started === undefined &&
      resourceState.thread.connectionScope !== "supervision" &&
      shouldUseFreshCodexThreadAfterContextEngineOverflow({
        error: turnStartError,
        contextEngineActive: Boolean(activeContextEngine),
        thread: resourceState.thread,
      }) &&
      resourceState.restartContextEngineCodexThread
    ) {
      try {
        assertCodexBindingMayBeReplaced(
          resourceState.thread,
          "retrying an overflow on a fresh native thread",
          params.expectedSessionRuntimeOwnership,
        );
        embeddedAgentLog.warn(
          "codex app-server context-engine turn overflowed on resume; retrying with fresh thread",
          { threadId: resourceState.thread.threadId, error: formatErrorMessage(turnStartError) },
        );
        const clearedBinding = await bindingStore.mutate(bindingIdentity, {
          kind: "clear",
          threadId: resourceState.thread.threadId,
        });
        if (!clearedBinding) {
          embeddedAgentLog.warn(
            "codex app-server preserved newer context-engine binding after resume overflow; skipping fresh retry",
            { threadId: resourceState.thread.threadId, error: formatErrorMessage(turnStartError) },
          );
        } else {
          resourceState.thread = await resourceState.restartContextEngineCodexThread();
          const retryBinding = bindingStore.read(bindingIdentity);
          if (
            retryBinding &&
            retryBinding.threadId === resourceState.thread.threadId &&
            retryBinding.contextEngine?.projection
          ) {
            await bindingStore.mutate(bindingIdentity, {
              kind: "patch",
              threadId: retryBinding.threadId,
              patch: {
                contextEngine: { ...retryBinding.contextEngine, projection: undefined },
              },
            });
            embeddedAgentLog.info(
              "codex app-server cleared stale context-engine projection after overflow retry",
              {
                threadId: resourceState.thread.threadId,
                previousEpoch: retryBinding.contextEngine.projection.epoch,
              },
            );
          }
          void emitCodexAppServerEvent(params, {
            stream: "codex_app_server.lifecycle",
            data: { phase: "thread_ready_retry", threadId: resourceState.thread.threadId },
          });
          try {
            started = await startCodexTurn();
          } catch (retryError) {
            turnStartError = retryError;
          }
        }
      } catch (retrySetupError) {
        turnStartError = retrySetupError;
      }
    }
    if (started === undefined) {
      const usageLimitError = await formatCodexTurnStartUsageLimitError({
        client: resourceState.client,
        error: turnStartError,
        errorNotification: state.latestStartupErrorNotification,
        rateLimitsRevisionBeforeTurnStart: state.rateLimitsRevisionBeforeLastTurnStart,
        timeoutMs: appServer.requestTimeoutMs,
        signal: runAbortController.signal,
      });
      const message = usageLimitError?.message ?? formatErrorMessage(turnStartError);
      if (isInvalidCodexImagePayloadError(message)) {
        await clearCodexBindingAfterInvalidImagePayload(
          bindingStore,
          bindingIdentity,
          { phase: "turn_start", threadId: resourceState.thread.threadId, error: message },
          params.expectedSessionRuntimeOwnership,
        );
      }
      void emitCodexAppServerEvent(params, {
        stream: "codex_app_server.lifecycle",
        data: { phase: "turn_start_failed", error: message },
      });
      trajectoryRecorder?.recordEvent("session.ended", {
        status: "error",
        threadId: resourceState.thread.threadId,
        timedOut: state.timeout !== undefined,
        aborted: runAbortController.signal.aborted,
        promptError: message,
      });
      markTrajectoryEndRecorded();
      runAgentHarnessLlmOutputHook({
        event: {
          runId: params.runId,
          sessionId: params.sessionId,
          provider: usesSupervisionConnection
            ? (resourceState.thread.modelProvider ?? effectiveRuntimeProviderId)
            : params.provider,
          model: usesSupervisionConnection
            ? (resourceState.thread.model ?? effectiveRuntimeModelId)
            : params.modelId,
          ...hookContextWindowFields,
          resolvedRef: usesSupervisionConnection
            ? `${resourceState.thread.modelProvider ?? effectiveRuntimeProviderId}/${resourceState.thread.model ?? effectiveRuntimeModelId}`
            : (params.runtimePlan?.observability.resolvedRef ??
              `${params.provider}/${params.modelId}`),
          ...(!usesSupervisionConnection && params.runtimePlan?.observability.harnessId
            ? { harnessId: params.runtimePlan.observability.harnessId }
            : {}),
          assistantTexts: [],
        },
        ctx: hookContext,
        hookRunner,
      });
      const failureKind = classifyCodexModelCallFailureKind({
        error: turnStartError,
        timedOut: state.timeout !== undefined,
        runAborted: runAbortController.signal.aborted,
        abortReason: runAbortController.signal.reason,
        clientClosedAbort: state.clientClosedAbort,
        formatError: formatErrorMessage,
      });
      codexModelCallDiagnostics.emitError(message, failureKind ? { failureKind } : {});
      const messagesSnapshot = [
        ...historyState.messages,
        buildCodexUserPromptMessage({ ...runtimeParams, prompt: turnState.codexTurnPromptText }),
      ];
      await runCodexAgentEndHook(params, {
        event: {
          messages: messagesSnapshot,
          success: false,
          error: message,
          durationMs: Date.now() - attemptStartedAt,
        },
        ctx: hookContext,
        hookRunner,
      });
      if (usageLimitError) {
        await markCodexAuthProfileBlockedFromRateLimits({
          params,
          authProfileId: startupAuthProfileId,
          rateLimits: usageLimitError.rateLimitsForProfile,
        });
        return {
          result: buildCodexTurnStartFailureResult({
            params,
            message: usageLimitError.message,
            promptError: new CodexUsageLimitPromptError(usageLimitError.message),
            messagesSnapshot,
            systemPromptReport,
          }),
        };
      }
      if (isCodexContextRestartSelectionChangedError(turnStartError)) {
        return {
          result: {
            ...buildCodexTurnStartFailureResult({
              params,
              message,
              messagesSnapshot,
              systemPromptReport,
            }),
            codexAppServerFailure: {
              kind: "client_closed_before_turn_completed" as const,
              transport: appServer.start.transport,
              threadId: resourceState.thread.threadId,
              replaySafe: true,
            },
          },
        };
      }
      throw turnStartError;
    }
  }
  if (!started) {
    throw new Error("codex app-server turn/start failed without an error");
  }
  const authoritySourceRef = context.attemptTools.scheduledAppAuthoritySourceRef;
  if (resourceState.thread.pluginAppPolicyContext) {
    authoritySourceRef.current = {
      client: resourceState.client,
      threadId: resourceState.thread.threadId,
      policyContext: resourceState.thread.pluginAppPolicyContext,
      configCwd: connection.effectiveCwd,
    };
  }
  turnIdRef.current = started.turn.turn.id;
  resourceState.nativeSubagentMonitor?.bindTurn(started.turn.turn.id);
  return started;
}
