import { sanitizeForLog } from "../../../terminal/ansi.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { formatAssistantErrorText, formatBillingErrorMessage, isTimeoutErrorMessage, } from "../../pi-embedded-helpers.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision, } from "./failover-policy.js";
export async function handleAssistantFailover(params) {
    let overloadProfileRotations = params.overloadProfileRotations;
    let decision = params.initialDecision;
    const sameModelIdleTimeoutRetry = () => {
        params.warn(`[llm-idle-timeout] ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} produced no reply before the idle watchdog; retrying same model`);
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
                params.warn(`Profile ${params.lastProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`);
            }
        }
        if (params.failoverReason === "overloaded") {
            overloadProfileRotations += 1;
            if (overloadProfileRotations > params.overloadProfileRotationLimit &&
                params.fallbackConfigured) {
                const status = resolveFailoverStatus("overloaded");
                params.warn(`overload profile rotation cap reached for ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} after ${overloadProfileRotations} rotations; escalating to model fallback`);
                params.logAssistantFailoverDecision("fallback_model", { status });
                return {
                    action: "throw",
                    overloadProfileRotations,
                    error: new FailoverError("The AI service is temporarily overloaded. Please try again in a moment.", {
                        reason: "overloaded",
                        provider: params.activeErrorContext.provider,
                        model: params.activeErrorContext.model,
                        profileId: params.lastProfileId,
                        status,
                        rawError: params.lastAssistant?.errorMessage?.trim(),
                    }),
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
        const message = resolveAssistantFailoverErrorMessage(params);
        const status = resolveFailoverStatus(decision.reason) ?? (isTimeoutErrorMessage(message) ? 408 : undefined);
        params.logAssistantFailoverDecision("fallback_model", { status });
        return {
            action: "throw",
            overloadProfileRotations,
            error: new FailoverError(message, {
                reason: decision.reason,
                provider: params.activeErrorContext.provider,
                model: params.activeErrorContext.model,
                profileId: params.lastProfileId,
                status,
                rawError: params.lastAssistant?.errorMessage?.trim(),
            }),
        };
    }
    if (decision.action === "surface_error") {
        if (!params.externalAbort && params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
            return sameModelIdleTimeoutRetry();
        }
        params.logAssistantFailoverDecision("surface_error");
        // Two surface_error shapes already have downstream synthesis and
        // must keep falling through to `continue_normal`:
        //   1. External abort (user pressed stop) — partial assistant
        //      output carries the turn; no provider error to synthesize.
        //   2. Timeout without an idle-retry — run.ts emits a dedicated
        //      timeout payload when buildEmbeddedRunPayloads produces no
        //      assistant content (see the `timedOut &&
        //      !timedOutDuringCompaction && !payloadsWithToolMedia.length`
        //      block in run.ts). Throwing here would short-circuit that
        //      synthesis and break timeout-compaction retry coverage.
        // Every other surface_error is a concrete provider failure that
        // continue_normal would silently drop before the payload builder
        // sees it (openclaw#70124: billing errors reached the gateway
        // but never the webchat because stopReason was not "error" and
        // no other synthesis path caught them). Throw a FailoverError so
        // the client surface can render it the same way it already
        // renders fallback_model failures.
        if (!params.externalAbort && !params.timedOut) {
            const message = resolveAssistantFailoverErrorMessage(params);
            const reason = resolveSurfaceErrorReason(decision.reason, params);
            const status = resolveFailoverStatus(reason) ?? (isTimeoutErrorMessage(message) ? 408 : undefined);
            return {
                action: "throw",
                overloadProfileRotations,
                error: new FailoverError(message, {
                    reason,
                    provider: params.activeErrorContext.provider,
                    model: params.activeErrorContext.model,
                    profileId: params.lastProfileId,
                    status,
                    rawError: params.lastAssistant?.errorMessage?.trim(),
                }),
            };
        }
    }
    return {
        action: "continue_normal",
        overloadProfileRotations,
    };
}
function resolveAssistantFailoverErrorMessage(params) {
    return ((params.lastAssistant
        ? formatAssistantErrorText(params.lastAssistant, {
            cfg: params.config,
            sessionKey: params.sessionKey,
            provider: params.activeErrorContext.provider,
            model: params.activeErrorContext.model,
        })
        : undefined) ||
        params.lastAssistant?.errorMessage?.trim() ||
        (params.timedOut
            ? "LLM request timed out."
            : params.rateLimitFailure
                ? "LLM request rate limited."
                : params.billingFailure
                    ? formatBillingErrorMessage(params.activeErrorContext.provider, params.activeErrorContext.model)
                    : params.authFailure
                        ? "LLM request unauthorized."
                        : "LLM request failed."));
}
// surface_error decisions can arrive with `reason: null` when
// shouldRotateAssistant fired on `failoverFailure` without a classified
// upstream reason. FailoverError requires a concrete reason, so map
// null onto the most specific failure the run observed, falling back
// to "unknown" when no signal is set. Callers only hit this helper on
// the non-timeout throw branch, so timeouts don't need a case here.
function resolveSurfaceErrorReason(declared, params) {
    if (declared) {
        return declared;
    }
    if (params.billingFailure) {
        return "billing";
    }
    if (params.authFailure) {
        return "auth";
    }
    if (params.rateLimitFailure) {
        return "rate_limit";
    }
    return "unknown";
}
