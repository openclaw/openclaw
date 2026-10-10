import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { classifyGatewayStorageFailure } from "../../../infra/sqlite-error-diagnostics.js";
import { isTerminalAssistantError } from "../../../llm/utils/retry.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import {
  classifyAssistantFailoverReason,
  formatBillingErrorMessage,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
  isTimeoutErrorMessage,
  isAuthAssistantError,
  isBillingAssistantError,
  isFailoverAssistantError,
  isRateLimitAssistantError,
  parseImageDimensionError,
  pickFallbackThinkingLevel,
} from "../../embedded-agent-helpers.js";
import { buildAssistantFailoverSignal } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import {
  classifyRateLimitWindow,
  isRetryableProviderHttpStatus,
  shouldRetryFailoverSignal,
} from "../../failover/retry-evidence.js";
import type { FailoverReason } from "../../failover/signal.js";
import { resolveSessionSuspensionReason } from "../../session-suspension.js";
import { isSessionTranscriptTurnMismatchErrorMessage } from "../../sessions/transcript-turn-error.js";
import { log } from "../logger.js";
import type { TraceAttempt } from "../types.js";
import type { NormalizedEmbeddedRunAttempt } from "./attempt-normalization.js";
import { isCurrentAttemptReplaySafe } from "./attempt-terminal-evidence.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";
import type { EmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { shouldRetrySilentErrorAssistantTurn } from "./incomplete-turn-recovery.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import { isEmbeddedRunTerminalInterrupted } from "./terminal-outcome.js";

const MAX_EMPTY_ERROR_RETRIES = 3;

type EmbeddedRunAssistantFailureOutcome = {
  action: "retry" | "proceed";
  thinkLevel: ThinkLevel;
  authRetryPending: boolean;
  emptyErrorRetries: number;
  overloadProfileRotations: number;
  lastRetryFailoverReason: FailoverReason | null;
  assistantProfileFailureReason: AuthProfileFailureReason | null;
};

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;

export async function handleEmbeddedAssistantFailure(input: {
  runInput: Pick<
    PreparedEmbeddedRunInput,
    "runParams" | "fallbackConfigured" | "suspendForFailure" | "agentDir" | "isProbeSession"
  >;
  preparedRuntime: Pick<
    PreparedRuntime,
    | "provider"
    | "modelId"
    | "attemptedThinking"
    | "attemptAuthProfileStore"
    | "maybeRefreshRuntimeAuthForAuthError"
  > & { model: Pick<PreparedRuntime["model"], "id"> };
  normalizedAttempt: Pick<
    NormalizedEmbeddedRunAttempt,
    | "attempt"
    | "attemptAssistant"
    | "currentAttemptAssistant"
    | "terminalState"
    | "activeErrorContext"
  >;
  runtime: Pick<
    ReturnType<PreparedRuntime["snapshot"]>,
    "thinkLevel" | "lastProfileId" | "pluginHarnessOwnsTransport"
  >;
  providerOwner: PreparedProviderFailoverOwner | undefined;
  // Profile rotation resets thinking inside the runtime; read it after advancing.
  getThinkLevel: () => ThinkLevel;
  runtimeAuthRetry: boolean;
  failover: Pick<
    EmbeddedRunFailoverRetryController,
    | "resolveAuthProfileFailureReason"
    | "maybeMarkAuthProfileFailure"
    | "advanceAuthProfile"
    | "transientRetryCount"
    | "overloadProfileRotationLimit"
  >;
  emptyErrorRetries: number;
  overloadProfileRotations: number;
  previousRetryFailoverReason: FailoverReason | null;
  traceAttempts: TraceAttempt[];
  suspensionSessionId: string;
}): Promise<EmbeddedRunAssistantFailureOutcome> {
  const { runInput, preparedRuntime, normalizedAttempt, runtime } = input;
  const { attempt, terminalState, activeErrorContext } = normalizedAttempt;
  const { attemptAssistant, currentAttemptAssistant } = normalizedAttempt;
  const { provider, modelId, model } = preparedRuntime;
  // Successful responses can retain stale error fields. Only current failures
  // may drive retries, profile health, or failure copy.
  const failedAssistant = attemptAssistant?.stopReason === "error" ? attemptAssistant : undefined;
  const transcriptError = failedAssistant?.errorMessage;
  if (isSessionTranscriptTurnMismatchErrorMessage(transcriptError)) {
    throw new Error(transcriptError);
  }
  if (classifyGatewayStorageFailure(failedAssistant)) {
    return buildOutcome(input, { action: "proceed", assistantProfileFailureReason: null });
  }
  const {
    aborted,
    externalAbort: projectedExternalAbort,
    idleTimedOut,
    promptError,
    timedOut,
  } = projectAgentRunAttemptTerminal(attempt.terminal);
  const terminalInterrupted = isEmbeddedRunTerminalInterrupted(terminalState.outcome);
  const { signalOwnedInterruption } = terminalState;
  const fallbackThinking = pickFallbackThinkingLevel({
    message: failedAssistant?.errorMessage,
    attempted: preparedRuntime.attemptedThinking,
  });
  const authFailure = isAuthAssistantError(failedAssistant);
  const rateLimitFailure = isRateLimitAssistantError(failedAssistant);
  const billingFailure = isBillingAssistantError(failedAssistant);
  const failoverFailure = isFailoverAssistantError(failedAssistant);
  const assistantFailoverReason = classifyAssistantFailoverReason(failedAssistant, {
    providerOwner: input.providerOwner,
  });
  const assistantProviderStarted =
    Boolean(currentAttemptAssistant?.provider) || terminalState.outcome.providerStarted === true;
  const assistantProfileFailoverReason =
    assistantFailoverReason ??
    (assistantProviderStarted && (timedOut || idleTimedOut) ? "timeout" : null);
  const assistantProfileFailureReason = input.failover.resolveAuthProfileFailureReason(
    assistantProfileFailoverReason,
    {
      providerStarted: assistantProviderStarted,
      transientRateLimit:
        assistantProfileFailoverReason === "rate_limit" &&
        classifyRateLimitWindow(failedAssistant?.errorMessage).kind === "short",
    },
  );
  const terminalAssistantError = isTerminalAssistantError(attemptAssistant);
  if (terminalAssistantError || !isCurrentAttemptReplaySafe(attempt)) {
    return buildOutcome(input, {
      action: "proceed",
      assistantProfileFailureReason: terminalAssistantError ? null : assistantProfileFailureReason,
    });
  }
  if (fallbackThinking && !terminalInterrupted) {
    log.warn(
      `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
    );
    return buildOutcome(input, {
      action: "retry",
      thinkLevel: fallbackThinking,
      assistantProfileFailureReason,
    });
  }
  const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
  const imageDimensionError = parseImageDimensionError(failedAssistant?.errorMessage ?? "");
  // Transient failures already consumed their recovery budget. Only unclassified
  // empty errors use this separate response-repair limit.
  const unclassifiedError =
    assistantFailoverReason === null ||
    assistantFailoverReason === "no_error_details" ||
    assistantFailoverReason === "unclassified" ||
    assistantFailoverReason === "unknown";
  const assistantSignal = failedAssistant
    ? buildAssistantFailoverSignal(failedAssistant)
    : undefined;
  const assistantStatus = assistantSignal?.status;
  const nonRetryableClientError =
    assistantSignal !== undefined &&
    assistantStatus !== undefined &&
    assistantStatus >= 400 &&
    assistantStatus < 500 &&
    !isRetryableProviderHttpStatus(assistantStatus) &&
    !shouldRetryFailoverSignal({ classification: null, signal: assistantSignal });
  const replaySafeSilentErrorFailure =
    !authFailure &&
    !rateLimitFailure &&
    !billingFailure &&
    !cloudCodeAssistFormatError &&
    !imageDimensionError &&
    !terminalInterrupted &&
    !promptError &&
    !nonRetryableClientError &&
    shouldRetrySilentErrorAssistantTurn({
      attempt,
      assistant: failedAssistant,
    });
  if (
    replaySafeSilentErrorFailure &&
    unclassifiedError &&
    input.emptyErrorRetries < MAX_EMPTY_ERROR_RETRIES
  ) {
    const emptyErrorRetries = input.emptyErrorRetries + 1;
    log.warn(
      `[empty-error-retry] stopReason=error non-visible-output; resubmitting ` +
        `attempt=${emptyErrorRetries}/${MAX_EMPTY_ERROR_RETRIES} ` +
        `provider=${failedAssistant?.provider ?? provider} ` +
        `model=${failedAssistant?.model ?? model.id} ` +
        `sessionKey=${runInput.runParams.sessionKey ?? runInput.runParams.sessionId}`,
    );
    return buildOutcome(input, {
      action: "retry",
      emptyErrorRetries,
      assistantProfileFailureReason,
    });
  }

  // After replay-safe, invisible failures exhaust same-model retries, skip
  // profile rotation and let the configured model fallback recover.
  const exhaustedUnclassifiedSilentError =
    runInput.fallbackConfigured &&
    assistantFailoverReason === null &&
    replaySafeSilentErrorFailure &&
    input.emptyErrorRetries >= MAX_EMPTY_ERROR_RETRIES;
  const effectiveFailoverReason = exhaustedUnclassifiedSilentError
    ? ("unknown" as const)
    : assistantFailoverReason;

  const logFailoverDecision = createFailoverDecisionLogger({
    stage: "assistant",
    runId: runInput.runParams.runId,
    rawError: failedAssistant?.errorMessage?.trim(),
    failoverReason: effectiveFailoverReason,
    profileFailureReason: assistantProfileFailureReason,
    provider: activeErrorContext.provider,
    model: activeErrorContext.model,
    sourceProvider: failedAssistant?.provider ?? provider,
    sourceModel: failedAssistant?.model ?? modelId,
    profileId: runtime.lastProfileId,
    fallbackConfigured: runInput.fallbackConfigured,
    timedOut,
    aborted,
    retryCount: input.failover.transientRetryCount,
    profileRotationCount: input.overloadProfileRotations,
    attemptCount: input.traceAttempts.length + 1,
  });
  if (
    !signalOwnedInterruption &&
    authFailure &&
    (await preparedRuntime.maybeRefreshRuntimeAuthForAuthError(
      failedAssistant?.errorMessage ?? "",
      input.runtimeAuthRetry,
    ))
  ) {
    return buildOutcome(input, {
      action: "retry",
      authRetryPending: true,
      assistantProfileFailureReason,
    });
  }
  if (imageDimensionError && runtime.lastProfileId) {
    const details = [
      imageDimensionError.messageIndex !== undefined
        ? `message=${imageDimensionError.messageIndex}`
        : null,
      imageDimensionError.contentIndex !== undefined
        ? `content=${imageDimensionError.contentIndex}`
        : null,
      imageDimensionError.maxDimensionPx !== undefined
        ? `limit=${imageDimensionError.maxDimensionPx}px`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    log.warn(
      `Profile ${runtime.lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
    );
  }

  const resolveDecision = (profileRotated: boolean) =>
    resolveRunFailoverDecision({
      stage: "assistant",
      allowFormatRetry: cloudCodeAssistFormatError,
      terminal: attempt.terminal,
      signalOwnedInterruption,
      fallbackConfigured: runInput.fallbackConfigured,
      failoverFailure,
      failoverReason: assistantFailoverReason,
      harnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
      profileRotated,
    });
  const initialDecision = exhaustedUnclassifiedSilentError
    ? ({ action: "fallback_model", reason: "unknown" } as const)
    : resolveDecision(false);
  const authMode = runtime.lastProfileId
    ? preparedRuntime.attemptAuthProfileStore.profiles?.[runtime.lastProfileId]?.type
    : undefined;
  const terminalOutcome = terminalState.outcome;
  const externalAbort = projectedExternalAbort || signalOwnedInterruption;
  let overloadProfileRotations = input.overloadProfileRotations;
  let decision = initialDecision;
  const logDecision = (
    action: Parameters<typeof logFailoverDecision>[0],
    extra?: { status?: number },
  ) =>
    logFailoverDecision(action, {
      ...extra,
      retryCount: input.failover.transientRetryCount,
      profileRotationCount: overloadProfileRotations,
    });
  const recordTrace = (result: TraceAttempt["result"], status?: number) => {
    input.traceAttempts.push({
      provider: activeErrorContext.provider,
      model: activeErrorContext.model,
      result: effectiveFailoverReason === "timeout" ? "timeout" : result,
      ...(effectiveFailoverReason ? { reason: effectiveFailoverReason } : {}),
      stage: "assistant",
      ...(typeof status === "number" ? { status } : {}),
    });
  };
  const throwFailure = (error: FailoverError): never => {
    recordTrace(
      initialDecision.action === "fallback_model" ? "fallback_model" : "error",
      error.status,
    );
    if (error.suspend) {
      runInput.suspendForFailure({
        cfg: runInput.runParams.config,
        agentDir: runInput.agentDir,
        sessionId: input.suspensionSessionId,
        reason: resolveSessionSuspensionReason(error.reason),
        failedProvider: error.provider ?? provider,
        failedModel: error.model ?? modelId,
      });
    }
    throw error;
  };

  if (decision.action === "rotate_profile") {
    const failedProfileId = runtime.lastProfileId;
    const markFailedProfile = async () => {
      if (!assistantProfileFailureReason) {
        return;
      }
      try {
        await input.failover.maybeMarkAuthProfileFailure({
          profileId: failedProfileId,
          reason: assistantProfileFailureReason,
          modelId,
        });
      } catch (err) {
        log.warn(`profile failure mark failed: ${String(err)}`);
      }
    };

    if (assistantFailoverReason === "overloaded") {
      overloadProfileRotations += 1;
      if (
        overloadProfileRotations > input.failover.overloadProfileRotationLimit &&
        runInput.fallbackConfigured
      ) {
        const status = assistantStatus ?? resolveFailoverStatus("overloaded");
        log.warn(
          `overload profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${overloadProfileRotations} rotations; escalating to model fallback`,
        );
        await markFailedProfile();
        logDecision("fallback_model", { status });
        throwFailure(
          new FailoverError(
            "The AI service is temporarily overloaded. Please try again in a moment.",
            {
              reason: "overloaded",
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              profileId: runtime.lastProfileId,
              status,
              rawError: failedAssistant?.errorMessage?.trim(),
            },
          ),
        );
      }
    }

    const rotated = await input.failover.advanceAuthProfile(assistantFailoverReason, {
      failoverProvider: activeErrorContext.provider,
      failoverModel: activeErrorContext.model,
      logFallbackDecision: logFailoverDecision,
    });

    const markFailedProfilePromise = markFailedProfile();
    if (timedOut && !runInput.isProbeSession && failedProfileId) {
      const timeoutLabel = idleTimedOut ? "idle timeout (model silent)" : "timed out";
      // Existing credentials are rotation targets only when config authorizes them.
      log.warn(
        rotated
          ? `Profile ${failedProfileId} ${timeoutLabel}. Trying next account...`
          : `Profile ${failedProfileId} ${timeoutLabel}. No further authorized account for this provider; create a backup auth profile and add its id to auth.order to enable failover.`,
      );
    }
    if (cloudCodeAssistFormatError && failedProfileId) {
      log.warn(
        `Profile ${failedProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
      );
    }
    if (rotated) {
      // The selected replacement can retry while the failed profile's record settles.
      logDecision("rotate_profile");
      recordTrace("rotate_profile");
      return buildOutcome(input, {
        action: "retry",
        thinkLevel: input.getThinkLevel(),
        overloadProfileRotations,
        lastRetryFailoverReason: mergeRetryFailoverReason({
          previous: input.previousRetryFailoverReason,
          failoverReason: assistantFailoverReason,
          timedOut,
        }),
        assistantProfileFailureReason,
      });
    }
    await markFailedProfilePromise;
    decision = resolveDecision(true);
  }

  if (decision.action === "surface_error") {
    logDecision("surface_error");
  }
  // Surface only current provider failures; aborts, timeout payload synthesis,
  // and stale classified text retain the normal payload path.
  if (
    decision.action === "fallback_model" ||
    (decision.action === "surface_error" && !externalAbort && !timedOut && failoverFailure)
  ) {
    const message =
      (failedAssistant
        ? formatUserFacingAssistantErrorText(failedAssistant, {
            cfg: runInput.runParams.config,
            sessionKey: runInput.runParams.sessionKey ?? runInput.runParams.sessionId,
            agentId: runInput.runParams.agentId,
            provider: activeErrorContext.provider,
            providerOwner: input.providerOwner,
            model: activeErrorContext.model,
            authMode,
          })
        : undefined) ||
      failedAssistant?.errorMessage?.trim() ||
      (timedOut
        ? "LLM request timed out."
        : rateLimitFailure
          ? "LLM request rate limited."
          : billingFailure
            ? formatBillingErrorMessage(
                activeErrorContext.provider,
                activeErrorContext.model,
                authMode,
              )
            : authFailure
              ? "LLM request unauthorized."
              : GENERIC_ASSISTANT_ERROR_TEXT);
    const reason =
      decision.reason ??
      (billingFailure
        ? "billing"
        : authFailure
          ? "auth"
          : rateLimitFailure
            ? "rate_limit"
            : "unknown");
    const status =
      assistantStatus ??
      resolveFailoverStatus(reason) ??
      (isTimeoutErrorMessage(message) ? 408 : undefined);
    if (decision.action === "fallback_model") {
      logDecision("fallback_model", { status });
    }
    throwFailure(
      new FailoverError(message, {
        reason,
        provider: activeErrorContext.provider,
        model: activeErrorContext.model,
        profileId: runtime.lastProfileId,
        authMode,
        status,
        code: failedAssistant?.errorCode,
        rawError: failedAssistant?.errorMessage?.trim(),
        // Retry reason "timeout" also includes 5xx; only the terminal owner records a deadline.
        timeout:
          terminalOutcome.status === "timeout"
            ? {
                timeoutPhase: terminalOutcome.timeoutPhase,
                providerStarted: terminalOutcome.providerStarted,
              }
            : undefined,
        suspend:
          Boolean(runInput.runParams.sessionKey ?? runInput.runParams.sessionId) &&
          (reason === "rate_limit" || reason === "billing"),
      }),
    );
  }

  logDecision("continue_normal");
  return buildOutcome(input, {
    action: "proceed",
    overloadProfileRotations,
    assistantProfileFailureReason,
  });
}

function buildOutcome(
  input: Parameters<typeof handleEmbeddedAssistantFailure>[0],
  override: Partial<EmbeddedRunAssistantFailureOutcome> &
    Pick<EmbeddedRunAssistantFailureOutcome, "action" | "assistantProfileFailureReason">,
): EmbeddedRunAssistantFailureOutcome {
  return {
    action: override.action,
    thinkLevel: override.thinkLevel ?? input.runtime.thinkLevel,
    authRetryPending: override.authRetryPending ?? false,
    emptyErrorRetries: override.emptyErrorRetries ?? input.emptyErrorRetries,
    overloadProfileRotations: override.overloadProfileRotations ?? input.overloadProfileRotations,
    lastRetryFailoverReason: override.lastRetryFailoverReason ?? input.previousRetryFailoverReason,
    assistantProfileFailureReason: override.assistantProfileFailureReason,
  };
}
