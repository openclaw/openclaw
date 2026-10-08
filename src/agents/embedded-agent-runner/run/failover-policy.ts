import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { isCliTerminalStopCode } from "../../failover-error.js";
import type { FailoverReason } from "../../failover/signal.js";

type ProfileDecision = {
  action: "rotate_profile" | "surface_error";
  reason: FailoverReason | null;
};
type ModelFallbackDecision = { action: "fallback_model"; reason: FailoverReason };
export type RetryLimitFailoverDecision = ModelFallbackDecision | { action: "return_error_payload" };
type PromptFailoverDecision = ProfileDecision | ModelFallbackDecision;
export type AssistantFailoverDecision = PromptFailoverDecision | { action: "continue_normal" };
type RunFailoverDecision = RetryLimitFailoverDecision | AssistantFailoverDecision;

type RetryLimitDecisionParams = {
  stage: "retry_limit";
  fallbackConfigured: boolean;
  failoverReason: FailoverReason | null;
};

type PromptDecisionParams = {
  stage: "prompt";
  allowFormatRetry?: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverCode?: string;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  harnessOwnsTransport?: boolean;
  promptTimeoutFallbackSafe?: boolean;
  timedOutByRunBudget?: boolean;
  profileRotated: boolean;
};

type AssistantDecisionParams = {
  stage: "assistant";
  allowFormatRetry?: boolean;
  terminal: AgentRunAttemptTerminal;
  signalOwnedInterruption?: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  harnessOwnsTransport?: boolean;
  profileRotated: boolean;
};

type RunFailoverDecisionParams =
  | RetryLimitDecisionParams
  | PromptDecisionParams
  | AssistantDecisionParams;

function isTerminalFormatFailure(params: {
  allowFormatRetry?: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
}): boolean {
  return (
    params.failoverFailure && params.failoverReason === "format" && params.allowFormatRetry !== true
  );
}

function shouldRotatePrompt(params: PromptDecisionParams): boolean {
  return (
    params.failoverFailure &&
    params.failoverReason !== "timeout" &&
    params.failoverReason !== "tls_certificate" &&
    !isTerminalFormatFailure(params)
  );
}

function isAssistantTimeoutFailure(params: AssistantDecisionParams): boolean {
  return (
    params.terminal.kind === "timeout" &&
    params.terminal.source !== "observation" &&
    (params.terminal.source === "idle" || params.terminal.phase === "prompt")
  );
}

function isConcreteNonTimeoutAssistantFailure(params: AssistantDecisionParams): boolean {
  return (
    params.failoverFailure && Boolean(params.failoverReason) && params.failoverReason !== "timeout"
  );
}

function shouldRotateAssistant(params: AssistantDecisionParams): boolean {
  if (params.terminal.kind === "timeout" && params.terminal.source === "run_budget") {
    return false;
  }
  const timeoutFailure = isAssistantTimeoutFailure(params);
  const harnessOwnedTimeout =
    params.harnessOwnsTransport && (timeoutFailure || params.failoverReason === "timeout");
  if (harnessOwnedTimeout && !isConcreteNonTimeoutAssistantFailure(params)) {
    return false;
  }
  const aborted =
    (params.terminal.kind === "aborted" && params.terminal.source !== "yield_cleanup") ||
    (params.terminal.kind === "timeout" &&
      params.terminal.source !== "observation" &&
      params.terminal.aborted === true);
  return (!aborted && params.failoverFailure) || timeoutFailure;
}

/** Preserves an existing retry reason unless the current attempt produced a stronger signal. */
export function mergeRetryFailoverReason(params: {
  previous: FailoverReason | null;
  failoverReason: FailoverReason | null;
  timedOut?: boolean;
}): FailoverReason | null {
  return params.failoverReason ?? params.previous ?? (params.timedOut ? "timeout" : null);
}

export function resolveRunFailoverDecision(
  params: RetryLimitDecisionParams,
): RetryLimitFailoverDecision;
export function resolveRunFailoverDecision(params: PromptDecisionParams): PromptFailoverDecision;
export function resolveRunFailoverDecision(
  params: AssistantDecisionParams,
): AssistantFailoverDecision;
/**
 * Chooses whether a run should rotate auth profile, switch model fallback,
 * surface the error, continue normally, or return an error payload. Prompt,
 * assistant, and retry-limit stages intentionally use different action sets.
 */
export function resolveRunFailoverDecision(params: RunFailoverDecisionParams): RunFailoverDecision {
  if (params.stage === "retry_limit") {
    const reason = params.failoverReason;
    if (
      params.fallbackConfigured &&
      reason &&
      reason !== "timeout" &&
      reason !== "format" &&
      reason !== "session_expired"
    ) {
      return {
        action: "fallback_model",
        reason,
      };
    }
    return {
      action: "return_error_payload",
    };
  }
  const surfaceError = { action: "surface_error" as const, reason: params.failoverReason };
  let shouldRotate: boolean;
  let shouldFallback: boolean;
  let fallbackReason: FailoverReason = params.failoverReason ?? "unknown";

  if (params.stage === "prompt") {
    // Plugin harnesses can forward CLI terminal codes through failover normalization;
    // normal CLI paths enforce the same stop in model-fallback-runner.
    if (
      isCliTerminalStopCode(params.failoverCode) ||
      params.externalAbort ||
      params.timedOutByRunBudget
    ) {
      return surfaceError;
    }
    if (params.harnessOwnsTransport && params.failoverReason === "timeout") {
      // Plugin harness lifecycle timeouts must stay inside the harness boundary;
      // only prompt request timeouts proven replay-safe may enter model fallback.
      if (params.promptTimeoutFallbackSafe === true && params.fallbackConfigured) {
        return {
          action: "fallback_model",
          reason: "timeout",
        };
      }
      return surfaceError;
    }
    shouldRotate = shouldRotatePrompt(params);
    shouldFallback = params.failoverFailure && !isTerminalFormatFailure(params);
  } else {
    if (
      params.signalOwnedInterruption ||
      ((params.terminal.kind === "aborted" || params.terminal.kind === "timeout") &&
        params.terminal.source === "external") ||
      isTerminalFormatFailure(params)
    ) {
      return surfaceError;
    }
    if (params.failoverFailure && params.failoverReason === "tls_certificate") {
      return params.fallbackConfigured
        ? { action: "fallback_model", reason: "tls_certificate" }
        : surfaceError;
    }
    shouldRotate = shouldRotateAssistant(params);
    if (!shouldRotate) {
      return { action: "continue_normal" };
    }
    shouldFallback = true;
    if (!isConcreteNonTimeoutAssistantFailure(params) && isAssistantTimeoutFailure(params)) {
      fallbackReason = "timeout";
    }
  }
  if (!params.profileRotated && shouldRotate) {
    return {
      action: "rotate_profile",
      reason: params.failoverReason,
    };
  }
  return shouldFallback && params.fallbackConfigured
    ? { action: "fallback_model", reason: fallbackReason }
    : surfaceError;
}
