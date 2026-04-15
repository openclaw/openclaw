import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import {
  formatAssistantErrorText,
  formatBillingErrorMessage,
  isTimeoutErrorMessage,
  type FailoverReason,
} from "../../pi-embedded-helpers.js";
import {
  mergeRetryFailoverReason,
  resolveRunFailoverDecision,
  type AssistantFailoverDecision,
} from "./failover-policy.js";

type AssistantFailoverOutcome =
  | {
      action: "continue_normal";
      overloadProfileRotations: number;
    }
  | {
      action: "retry";
      overloadProfileRotations: number;
      lastRetryFailoverReason: FailoverReason | null;
      retryKind?: "same_model_idle_timeout";
    }
  | {
      action: "throw";
      overloadProfileRotations: number;
      error: FailoverError;
    };

type FailoverMessageParams = {
  timedOut: boolean;
  billingFailure: boolean;
  rateLimitFailure: boolean;
  authFailure: boolean;
  lastAssistant: AssistantMessage | undefined;
  config: OpenClawConfig | undefined;
  sessionKey?: string;
  activeErrorContext: { provider: string; model: string };
};

// Shared by the `fallback_model` and `surface_error` branches. Preserves the
// legacy `fallback_model` precedence in two ways:
//   1. Upstream assistant text wins over the generic type-specific messages,
//      so users see provider/model-specific context (e.g.
//      "deepseek/deepseek-chat: 429 …") rather than a canonical one-liner.
//   2. Among the type-specific fallbacks the order is
//      timeout → rate_limit → billing → auth. This matters when an error
//      matches multiple classifiers (e.g. an "insufficient quota" body
//      trips both `isRateLimitAssistantError` and `isBillingAssistantError`).
//      The decision/status path frequently keeps `rate_limit` (status 429),
//      so the user-facing message must agree — otherwise the chat would say
//      "billing" while the backend emitted a 429.
function buildFailoverMessage(params: FailoverMessageParams): string {
  if (params.lastAssistant) {
    const formatted = formatAssistantErrorText(params.lastAssistant, {
      cfg: params.config,
      sessionKey: params.sessionKey,
      provider: params.activeErrorContext.provider,
      model: params.activeErrorContext.model,
    });
    const trimmed = params.lastAssistant.errorMessage?.trim();
    if (formatted) {
      return formatted;
    }
    if (trimmed) {
      return trimmed;
    }
  }
  if (params.timedOut) {
    return "LLM request timed out.";
  }
  if (params.rateLimitFailure) {
    return "LLM request rate limited.";
  }
  if (params.billingFailure) {
    return formatBillingErrorMessage(
      params.activeErrorContext.provider,
      params.activeErrorContext.model,
    );
  }
  if (params.authFailure) {
    return "LLM request unauthorized.";
  }
  return "LLM request failed.";
}

function resolveFailoverStatusOrTimeout(
  reason: FailoverReason,
  message: string,
): number | undefined {
  const fromReason = resolveFailoverStatus(reason);
  if (fromReason !== undefined) {
    return fromReason;
  }
  if (isTimeoutErrorMessage(message)) {
    return 408;
  }
  return undefined;
}

function resolveSurfaceReason(
  decisionReason: FailoverReason | null | undefined,
  timedOut: boolean,
): FailoverReason {
  if (decisionReason) {
    return decisionReason;
  }
  if (timedOut) {
    return "timeout";
  }
  return "unknown";
}

// Shared throw-outcome shape for the `fallback_model` and `surface_error`
// branches. Returns the computed status alongside the outcome so the caller
// can decide how (or whether) to include it in the decision log.
function buildFailoverThrowOutcome(params: {
  reason: FailoverReason;
  overloadProfileRotations: number;
  messageParams: FailoverMessageParams;
  lastProfileId?: string;
  activeErrorContext: { provider: string; model: string };
}): {
  outcome: Extract<AssistantFailoverOutcome, { action: "throw" }>;
  status: number | undefined;
} {
  const message = buildFailoverMessage(params.messageParams);
  const status = resolveFailoverStatusOrTimeout(params.reason, message);
  return {
    status,
    outcome: {
      action: "throw",
      overloadProfileRotations: params.overloadProfileRotations,
      error: new FailoverError(message, {
        reason: params.reason,
        provider: params.activeErrorContext.provider,
        model: params.activeErrorContext.model,
        profileId: params.lastProfileId,
        status,
      }),
    },
  };
}

export async function handleAssistantFailover(params: {
  initialDecision: AssistantFailoverDecision;
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  allowSameModelIdleTimeoutRetry: boolean;
  assistantProfileFailureReason: AuthProfileFailureReason | null;
  lastProfileId?: string;
  modelId: string;
  provider: string;
  activeErrorContext: { provider: string; model: string };
  lastAssistant: AssistantMessage | undefined;
  config: OpenClawConfig | undefined;
  sessionKey?: string;
  authFailure: boolean;
  rateLimitFailure: boolean;
  billingFailure: boolean;
  cloudCodeAssistFormatError: boolean;
  isProbeSession: boolean;
  overloadProfileRotations: number;
  overloadProfileRotationLimit: number;
  previousRetryFailoverReason: FailoverReason | null;
  logAssistantFailoverDecision: (
    decision: "rotate_profile" | "fallback_model" | "surface_error",
    extra?: { status?: number },
  ) => void;
  warn: (message: string) => void;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeEscalateRateLimitProfileFallback: (params: {
    failoverProvider: string;
    failoverModel: string;
    logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
  }) => void;
  maybeBackoffBeforeOverloadFailover: (reason: FailoverReason | null) => Promise<void>;
  advanceAuthProfile: () => Promise<boolean>;
}): Promise<AssistantFailoverOutcome> {
  let overloadProfileRotations = params.overloadProfileRotations;
  let decision = params.initialDecision;
  const sameModelIdleTimeoutRetry = (): AssistantFailoverOutcome => {
    params.warn(
      `[llm-idle-timeout] ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} produced no reply before the idle watchdog; retrying same model`,
    );
    return {
      action: "retry",
      overloadProfileRotations,
      retryKind: "same_model_idle_timeout",
      lastRetryFailoverReason: mergeRetryFailoverReason({
        previous: params.previousRetryFailoverReason,
        failoverReason: params.failoverReason,
        timedOut: true,
      }),
    };
  };

  if (decision.action === "rotate_profile") {
    if (params.lastProfileId) {
      const reason = params.timedOut ? "timeout" : params.assistantProfileFailureReason;
      await params.maybeMarkAuthProfileFailure({
        profileId: params.lastProfileId,
        reason,
        modelId: params.modelId,
      });
      if (params.timedOut && !params.isProbeSession) {
        params.warn(`Profile ${params.lastProfileId} timed out. Trying next account...`);
      }
      if (params.cloudCodeAssistFormatError) {
        params.warn(
          `Profile ${params.lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
        );
      }
    }

    if (params.failoverReason === "overloaded") {
      overloadProfileRotations += 1;
      if (
        overloadProfileRotations > params.overloadProfileRotationLimit &&
        params.fallbackConfigured
      ) {
        const status = resolveFailoverStatus("overloaded");
        params.warn(
          `overload profile rotation cap reached for ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} after ${overloadProfileRotations} rotations; escalating to model fallback`,
        );
        params.logAssistantFailoverDecision("fallback_model", { status });
        return {
          action: "throw",
          overloadProfileRotations,
          error: new FailoverError(
            "The AI service is temporarily overloaded. Please try again in a moment.",
            {
              reason: "overloaded",
              provider: params.activeErrorContext.provider,
              model: params.activeErrorContext.model,
              profileId: params.lastProfileId,
              status,
            },
          ),
        };
      }
    }

    if (params.failoverReason === "rate_limit") {
      params.maybeEscalateRateLimitProfileFallback({
        failoverProvider: params.activeErrorContext.provider,
        failoverModel: params.activeErrorContext.model,
        logFallbackDecision: params.logAssistantFailoverDecision,
      });
    }

    const rotated = await params.advanceAuthProfile();
    if (rotated) {
      params.logAssistantFailoverDecision("rotate_profile");
      await params.maybeBackoffBeforeOverloadFailover(params.failoverReason);
      return {
        action: "retry",
        overloadProfileRotations,
        lastRetryFailoverReason: mergeRetryFailoverReason({
          previous: params.previousRetryFailoverReason,
          failoverReason: params.failoverReason,
          timedOut: params.timedOut,
        }),
      };
    }
    if (params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
      return sameModelIdleTimeoutRetry();
    }

    decision = resolveRunFailoverDecision({
      stage: "assistant",
      aborted: params.aborted,
      externalAbort: params.externalAbort,
      fallbackConfigured: params.fallbackConfigured,
      failoverFailure: params.failoverFailure,
      failoverReason: params.failoverReason,
      timedOut: params.timedOut,
      timedOutDuringCompaction: params.timedOutDuringCompaction,
      profileRotated: true,
    });
  }

  if (decision.action === "fallback_model") {
    await params.maybeBackoffBeforeOverloadFailover(params.failoverReason);
    const { outcome, status } = buildFailoverThrowOutcome({
      reason: decision.reason,
      overloadProfileRotations,
      messageParams: params,
      lastProfileId: params.lastProfileId,
      activeErrorContext: params.activeErrorContext,
    });
    params.logAssistantFailoverDecision("fallback_model", { status });
    return outcome;
  }

  if (decision.action === "surface_error") {
    if (!params.externalAbort && params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
      return sameModelIdleTimeoutRetry();
    }

    // Two cases route through `surface_error` but must NOT throw a synthetic
    // `FailoverError`:
    //   1. `externalAbort` — user/system cancellation. Throwing here would show
    //      a misleading generic error and bypass the normal cancellation flow.
    //   2. `timedOut` — `run.ts` has a dedicated timeout payload builder that
    //      emits a helpful, config-key-aware error ("increase `agents.defaults.
    //      llm.idleTimeoutSeconds` …"). Throwing here short-circuits that path
    //      and replaces a specific message with a generic one.
    // In both cases we still log the decision for observability and fall
    // through to `continue_normal` so the outer run loop can handle it.
    if (params.externalAbort || params.timedOut) {
      params.logAssistantFailoverDecision("surface_error");
      return {
        action: "continue_normal",
        overloadProfileRotations,
      };
    }

    // Non-timeout terminal failures (auth / billing / rate-limit / unknown
    // upstream error) were previously swallowed here — they had no dedicated
    // payload builder downstream, so the UI saw nothing. Mirror the
    // `fallback_model` branch: build a descriptive message + HTTP status and
    // throw a `FailoverError` so the dispatcher can propagate it to the chat.
    const { outcome, status } = buildFailoverThrowOutcome({
      reason: resolveSurfaceReason(decision.reason, params.timedOut),
      overloadProfileRotations,
      messageParams: params,
      lastProfileId: params.lastProfileId,
      activeErrorContext: params.activeErrorContext,
    });
    params.logAssistantFailoverDecision("surface_error", { status });
    return outcome;
  }

  return {
    action: "continue_normal",
    overloadProfileRotations,
  };
}
