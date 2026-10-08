import { CompactionReplayRefreshRequiredError } from "@openclaw/ai/transports";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { formatErrorMessage, toErrorObject } from "../../../infra/errors.js";
import {
  buildAgentRunTerminalOutcomeFromAttempt,
  projectAgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import {
  classifyFailoverReason,
  parseImageSizeError,
  pickFallbackThinkingLevel,
} from "../../embedded-agent-helpers.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  hasRecordedModelFallbackStop,
  isCliTerminalStopCode,
  resolveFailoverStatus,
} from "../../failover-error.js";
import { classifyRateLimitWindow } from "../../failover/retry-evidence.js";
import type { FailoverReason } from "../../failover/signal.js";
import { isAgentHarnessPreflightError } from "../../harness/errors.js";
import { resolveSessionSuspensionReason } from "../../session-suspension.js";
import { log } from "../logger.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult, TraceAttempt } from "../types.js";
import type { NormalizedEmbeddedRunAttempt } from "./attempt-normalization.js";
import { buildEmbeddedRunBlockedResult } from "./blocked-run-result.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";
import type { EmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";

type PromptFailureOutcome =
  | {
      action: "retry";
      thinkLevel: ThinkLevel;
      authRetryPending: boolean;
      lastRetryFailoverReason: FailoverReason | null;
    }
  | { action: "complete"; result: EmbeddedAgentRunResult };

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;

export async function handleEmbeddedPromptFailure(input: {
  runInput: Pick<
    PreparedEmbeddedRunInput,
    | "runParams"
    | "globalLane"
    | "agentDir"
    | "suspendForFailure"
    | "startedAtMs"
    | "fallbackConfigured"
  >;
  preparedRuntime: Pick<
    PreparedRuntime,
    | "provider"
    | "modelId"
    | "attemptAuthProfileStore"
    | "maybeRefreshRuntimeAuthForAuthError"
    | "attemptedThinking"
  >;
  normalizedAttempt: Pick<
    NormalizedEmbeddedRunAttempt,
    | "attempt"
    | "activeErrorContext"
    | "sessionIdUsed"
    | "resolveReplayInvalidForAttempt"
    | "setTerminalLifecycleMeta"
  >;
  runtime: Pick<
    ReturnType<PreparedRuntime["snapshot"]>,
    "lastProfileId" | "thinkLevel" | "pluginHarnessOwnsTransport"
  >;
  terminal: Pick<
    ReturnType<typeof projectAgentRunAttemptTerminal>,
    "promptError" | "promptErrorSource" | "aborted" | "externalAbort" | "timedOutByRunBudget"
  >;
  suspensionSessionId: string;
  runtimeAuthRetry: boolean;
  buildErrorAgentMeta: () => EmbeddedAgentMeta;
  failover: Pick<
    EmbeddedRunFailoverRetryController,
    | "resolveAuthProfileFailureReason"
    | "advanceAuthProfile"
    | "advanceRateLimitAuthProfile"
    | "maybeMarkAuthProfileFailure"
    | "transientRetryCount"
  >;
  // Profile rotation resets thinking inside the runtime; read it after advancing.
  getThinkLevel: () => ThinkLevel;
  traceAttempts: TraceAttempt[];
  previousRetryFailoverReason: FailoverReason | null;
}): Promise<PromptFailureOutcome> {
  const { runInput, preparedRuntime, normalizedAttempt, runtime, terminal } = input;
  if (
    isAgentHarnessPreflightError(terminal.promptError) ||
    hasRecordedModelFallbackStop(terminal.promptError)
  ) {
    throw terminal.promptError;
  }
  // Only the local precheck owns this recovery; provider text cannot request it.
  if (
    terminal.promptErrorSource === "precheck" &&
    terminal.promptError instanceof CompactionReplayRefreshRequiredError
  ) {
    const text = new CompactionReplayRefreshRequiredError().message;
    return completeBlockedPromptFailure(input, {
      text,
      errorKind: "compaction_replay_refresh_required",
      errorMessage: text,
    });
  }
  const promptAuthMode = runtime.lastProfileId
    ? preparedRuntime.attemptAuthProfileStore.profiles?.[runtime.lastProfileId]?.type
    : undefined;
  const terminalOutcome = buildAgentRunTerminalOutcomeFromAttempt({
    terminal: normalizedAttempt.attempt.terminal,
    promptTimeoutOutcome: normalizedAttempt.attempt.promptTimeoutOutcome,
  });
  const failoverContext = {
    provider: normalizedAttempt.activeErrorContext.provider,
    model: normalizedAttempt.activeErrorContext.model,
    profileId: runtime.lastProfileId,
    authMode: promptAuthMode,
    sessionId: normalizedAttempt.sessionIdUsed,
    lane: runInput.globalLane,
    timeout:
      terminalOutcome.status === "timeout"
        ? {
            timeoutPhase: terminalOutcome.timeoutPhase,
            providerStarted: terminalOutcome.providerStarted,
          }
        : undefined,
  };
  const normalizedPromptFailover = coerceToFailoverError(terminal.promptError, failoverContext);
  const promptErrorDetails = describeFailoverError(
    normalizedPromptFailover ?? terminal.promptError,
  );
  if (normalizedPromptFailover?.suspend) {
    runInput.suspendForFailure({
      cfg: runInput.runParams.config,
      agentDir: runInput.agentDir,
      sessionId: input.suspensionSessionId,
      reason: resolveSessionSuspensionReason(normalizedPromptFailover.reason),
      failedProvider: normalizedPromptFailover.provider ?? preparedRuntime.provider,
      failedModel: normalizedPromptFailover.model ?? preparedRuntime.modelId,
    });
  }
  const errorText = promptErrorDetails.message || formatErrorMessage(terminal.promptError);
  // A recorded CLI terminal stop outranks every text-derived recovery below:
  // its message repeats a backend-controlled reason, so an auth-shaped value
  // would otherwise refresh and retry a turn whose tool effects already ran.
  const recordedTerminalStop = isCliTerminalStopCode(promptErrorDetails.code);
  if (
    !recordedTerminalStop &&
    (await preparedRuntime.maybeRefreshRuntimeAuthForAuthError(errorText, input.runtimeAuthRetry))
  ) {
    return {
      action: "retry",
      thinkLevel: runtime.thinkLevel,
      authRetryPending: true,
      lastRetryFailoverReason: input.previousRetryFailoverReason,
    };
  }

  const blockedResult = recordedTerminalStop
    ? undefined
    : resolveBlockedPromptResult(input, errorText);
  if (blockedResult) {
    return blockedResult;
  }

  const promptFailoverReason =
    promptErrorDetails.reason ??
    classifyFailoverReason(errorText, { provider: preparedRuntime.provider });
  const promptProfileFailureReason = input.failover.resolveAuthProfileFailureReason(
    promptFailoverReason,
    {
      providerStarted: terminal.promptErrorSource === "prompt",
      transientRateLimit:
        promptFailoverReason === "rate_limit" &&
        classifyRateLimitWindow(errorText).kind === "short",
    },
  );
  const promptTimeoutFallbackSafe =
    terminal.promptErrorSource === "prompt" &&
    promptFailoverReason === "timeout" &&
    !normalizedAttempt.attempt.codexAppServerFailure &&
    normalizedAttempt.attempt.promptTimeoutOutcome?.replayInvalid !== true &&
    normalizedAttempt.attempt.replayMetadata.replaySafe;
  const failedProfileId = runtime.lastProfileId;
  const logFailoverDecision = createFailoverDecisionLogger({
    stage: "prompt",
    runId: runInput.runParams.runId,
    rawError: errorText,
    failoverReason: promptFailoverReason,
    profileFailureReason: promptProfileFailureReason,
    provider: preparedRuntime.provider,
    model: preparedRuntime.modelId,
    sourceProvider: preparedRuntime.provider,
    sourceModel: preparedRuntime.modelId,
    profileId: failedProfileId,
    fallbackConfigured: runInput.fallbackConfigured,
    aborted: terminal.aborted,
    retryCount: input.failover.transientRetryCount,
    attemptCount: input.traceAttempts.length + 1,
  });
  const recordFailoverDecision = (
    decision: "rotate_profile" | "fallback_model" | "surface_error",
    reason = promptFailoverReason,
    status?: number,
  ) => {
    input.traceAttempts.push({
      provider: preparedRuntime.provider,
      model: preparedRuntime.modelId,
      result: promptFailoverReason === "timeout" ? "timeout" : decision,
      ...(reason ? { reason } : {}),
      stage: "prompt",
      ...(typeof status === "number" ? { status } : {}),
    });
    logFailoverDecision(decision, {
      ...(decision === "fallback_model" ? { status } : {}),
      retryCount: input.failover.transientRetryCount,
      profileRotationCount: decision === "rotate_profile" ? 1 : 0,
    });
  };
  const resolveDecision = (profileRotated: boolean) =>
    resolveRunFailoverDecision({
      stage: "prompt",
      externalAbort: terminal.externalAbort,
      fallbackConfigured: runInput.fallbackConfigured,
      failoverCode: promptErrorDetails.code,
      failoverFailure: promptFailoverReason !== null,
      failoverReason: promptFailoverReason,
      harnessOwnsTransport: runtime.pluginHarnessOwnsTransport,
      promptTimeoutFallbackSafe,
      timedOutByRunBudget: terminal.timedOutByRunBudget,
      profileRotated,
    });
  let failoverDecision = resolveDecision(false);
  let rotated = false;
  if (failoverDecision.action === "rotate_profile") {
    if (promptFailoverReason === "rate_limit") {
      rotated = await input.failover.advanceRateLimitAuthProfile({
        failoverProvider: preparedRuntime.provider,
        failoverModel: preparedRuntime.modelId,
        logFallbackDecision: logFailoverDecision,
      });
    } else {
      rotated = await input.failover.advanceAuthProfile();
    }
    if (!rotated) {
      failoverDecision = resolveDecision(true);
    }
  }
  const markFailedProfilePromise = promptProfileFailureReason
    ? input.failover
        .maybeMarkAuthProfileFailure({
          profileId: failedProfileId,
          reason: promptProfileFailureReason,
          modelId: preparedRuntime.modelId,
        })
        .catch((error: unknown) => {
          log.warn(`prompt profile failure mark failed: ${String(error)}`);
        })
    : undefined;
  if (rotated) {
    // A selected replacement can retry while the failed profile's record settles.
    recordFailoverDecision("rotate_profile");
    const lastRetryFailoverReason = mergeRetryFailoverReason({
      previous: input.previousRetryFailoverReason,
      failoverReason: promptFailoverReason,
    });
    return {
      action: "retry",
      thinkLevel: input.getThinkLevel(),
      authRetryPending: false,
      lastRetryFailoverReason,
    };
  }
  if (markFailedProfilePromise) {
    await markFailedProfilePromise;
  }
  const fallbackThinking = recordedTerminalStop
    ? undefined
    : pickFallbackThinkingLevel({
        message: errorText,
        attempted: preparedRuntime.attemptedThinking,
      });
  if (fallbackThinking) {
    log.warn(
      `unsupported thinking level for ${preparedRuntime.provider}/${preparedRuntime.modelId}; retrying with ${fallbackThinking}`,
    );
    logFailoverDecision("retry_thinking_level", {
      retryCount: input.failover.transientRetryCount,
    });
    return {
      action: "retry",
      thinkLevel: fallbackThinking,
      authRetryPending: false,
      lastRetryFailoverReason: input.previousRetryFailoverReason,
    };
  }
  if (failoverDecision.action === "fallback_model") {
    const fallbackReason = failoverDecision.reason;
    const status = resolveFailoverStatus(fallbackReason, promptErrorDetails.code);
    recordFailoverDecision("fallback_model", fallbackReason, status);
    throw (
      (normalizedPromptFailover?.reason === fallbackReason ? normalizedPromptFailover : null) ??
      new FailoverError(errorText, {
        ...failoverContext,
        reason: fallbackReason,
        provider: preparedRuntime.provider,
        model: preparedRuntime.modelId,
        status,
      })
    );
  }
  if (failoverDecision.action === "surface_error") {
    recordFailoverDecision("surface_error");
  }
  if (failoverContext.timeout) {
    throw (
      normalizedPromptFailover ??
      new FailoverError(errorText, {
        ...failoverContext,
        reason: "timeout",
        cause: terminal.promptError,
      })
    );
  }
  throw toErrorObject(terminal.promptError, "Prompt failed");
}

function resolveBlockedPromptResult(
  input: Parameters<typeof handleEmbeddedPromptFailure>[0],
  errorText: string,
): PromptFailureOutcome | undefined {
  let text: string;
  let errorKind: "role_ordering" | "image_size";
  if (/incorrect role information|roles must alternate/i.test(errorText)) {
    text =
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session.";
    errorKind = "role_ordering";
  } else {
    const imageSizeError = parseImageSizeError(errorText);
    if (!imageSizeError) {
      return undefined;
    }
    const maxMb = imageSizeError.maxMb;
    const maxMbLabel = typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
    const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
    text =
      `Image too large for the model${maxBytesHint}. ` +
      "Please compress or resize the image and try again.";
    errorKind = "image_size";
  }
  return completeBlockedPromptFailure(input, { text, errorKind, errorMessage: errorText });
}

function completeBlockedPromptFailure(
  input: Parameters<typeof handleEmbeddedPromptFailure>[0],
  copy: Pick<
    Parameters<typeof buildEmbeddedRunBlockedResult>[0],
    "text" | "errorKind" | "errorMessage"
  >,
): PromptFailureOutcome {
  const replayInvalid = input.normalizedAttempt.resolveReplayInvalidForAttempt();
  input.normalizedAttempt.setTerminalLifecycleMeta({ replayInvalid, livenessState: "blocked" });
  return {
    action: "complete",
    result: buildEmbeddedRunBlockedResult({
      ...copy,
      durationMs: Date.now() - input.runInput.startedAtMs,
      agentMeta: input.buildErrorAgentMeta(),
      attempt: input.normalizedAttempt.attempt,
      replayInvalid,
      finalPromptText: input.normalizedAttempt.attempt.finalPromptText,
    }),
  };
}
