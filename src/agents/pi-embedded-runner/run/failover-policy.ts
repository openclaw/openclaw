import type { FailoverReason } from "../../pi-embedded-helpers.js";

export type RunFailoverDecisionAction =
  | "continue_normal"
  | "rotate_profile"
  | "fallback_model"
  | "surface_error"
  | "return_error_payload";

export type RunFailoverDecision =
  | {
      action: "continue_normal";
    }
  | {
      action: "rotate_profile" | "surface_error";
      reason: FailoverReason | null;
    }
  | {
      action: "fallback_model";
      reason: FailoverReason;
    }
  | {
      action: "return_error_payload";
    };

export type RetryLimitFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "fallback_model" | "return_error_payload" }
>;

export type PromptFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "rotate_profile" | "fallback_model" | "surface_error" }
>;

export type AssistantFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "continue_normal" | "rotate_profile" | "fallback_model" | "surface_error" }
>;

type RetryLimitDecisionParams = {
  stage: "retry_limit";
  fallbackConfigured: boolean;
  failoverReason: FailoverReason | null;
};

type PromptDecisionParams = {
  stage: "prompt";
  allowFormatRetry?: boolean;
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  profileRotated: boolean;
};

type AssistantDecisionParams = {
  stage: "assistant";
  allowFormatRetry?: boolean;
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  timedOutDuringToolExecution: boolean;
  compactionFailureContext?: boolean;
  profileRotated: boolean;
};

export type RunFailoverDecisionParams =
  | RetryLimitDecisionParams
  | PromptDecisionParams
  | AssistantDecisionParams;

function shouldEscalateRetryLimit(reason: FailoverReason | null): boolean {
  return Boolean(
    reason &&
    reason !== "timeout" &&
    reason !== "model_not_found" &&
    reason !== "format" &&
    reason !== "session_expired",
  );
}

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
    !isTerminalFormatFailure(params)
  );
}

function isAssistantTimeoutFailure(params: AssistantDecisionParams): boolean {
  return (
    params.idleTimedOut ||
    (params.timedOut && !params.timedOutDuringCompaction && !params.timedOutDuringToolExecution)
  );
}

function shouldRotateAssistant(params: AssistantDecisionParams): boolean {
  if (isTerminalFormatFailure(params)) {
    return false;
  }
  return (!params.aborted && params.failoverFailure) || isAssistantTimeoutFailure(params);
}

export function mergeRetryFailoverReason(params: {
  previous: FailoverReason | null;
  failoverReason: FailoverReason | null;
  timedOut?: boolean;
}): FailoverReason | null {
  // timedOut takes precedence — timeout must always surface as the reason
  // to prevent session-lock deadlock (#86). A pre-existing failoverReason
  // (e.g. "rate_limit") must not mask a timeout condition.
  if (params.timedOut) {
    return "timeout";
  }
  return params.failoverReason ?? params.previous;
}

export function resolveRunFailoverDecision(
  params: RetryLimitDecisionParams,
): RetryLimitFailoverDecision;
export function resolveRunFailoverDecision(params: PromptDecisionParams): PromptFailoverDecision;
export function resolveRunFailoverDecision(
  params: AssistantDecisionParams,
): AssistantFailoverDecision;
export function resolveRunFailoverDecision(params: RunFailoverDecisionParams): RunFailoverDecision {
  if (params.stage === "retry_limit") {
    if (params.fallbackConfigured && shouldEscalateRetryLimit(params.failoverReason)) {
      const fallbackReason = params.failoverReason ?? "unknown";
      return {
        action: "fallback_model",
        reason: fallbackReason,
      };
    }
    return {
      action: "return_error_payload",
    };
  }

  if (params.stage === "prompt") {
    if (params.externalAbort) {
      return {
        action: "surface_error",
        reason: params.failoverReason,
      };
    }
    if (!params.profileRotated && shouldRotatePrompt(params)) {
      return {
        action: "rotate_profile",
        reason: params.failoverReason,
      };
    }
    if (params.fallbackConfigured && params.failoverFailure && !isTerminalFormatFailure(params)) {
      return {
        action: "fallback_model",
        reason: params.failoverReason ?? "unknown",
      };
    }
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }

  if (params.compactionFailureContext) {
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  if (params.externalAbort) {
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  if (
    params.timedOut &&
    !params.aborted &&
    !params.timedOutDuringToolExecution &&
    !params.timedOutDuringCompaction
  ) {
    // Plain LLM-phase timeout outside an in-flight abort: surface so local
    // timeout recovery can run (#86 deadlock fix). Aborted + LLM-phase
    // timeouts fall through to shouldRotateAssistant rotation; tool-execution
    // + compaction timeouts fall through to continue_normal (#52147 — neither
    // rotate nor fallback while a tool/compaction is in flight).
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  if (params.failoverReason === "timeout") {
    if (params.fallbackConfigured && params.failoverFailure) {
      return {
        action: "fallback_model",
        reason: "timeout",
      };
    }
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  if (isTerminalFormatFailure(params)) {
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  const assistantShouldRotate = shouldRotateAssistant(params);
  if (!params.profileRotated && assistantShouldRotate) {
    return {
      action: "rotate_profile",
      reason: params.failoverReason,
    };
  }
  if (assistantShouldRotate && params.fallbackConfigured) {
    return {
      action: "fallback_model",
      reason: isAssistantTimeoutFailure(params) ? "timeout" : (params.failoverReason ?? "unknown"),
    };
  }
  if (!assistantShouldRotate) {
    return {
      action: "continue_normal",
    };
  }
  return {
    action: "surface_error",
    reason: params.failoverReason,
  };
}
