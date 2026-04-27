function shouldEscalateRetryLimit(reason) {
    return Boolean(reason &&
        reason !== "timeout" &&
        reason !== "model_not_found" &&
        reason !== "format" &&
        reason !== "session_expired");
}
function shouldRotatePrompt(params) {
    return params.failoverFailure && params.failoverReason !== "timeout";
}
function shouldRotateAssistant(params) {
    return ((!params.aborted && (params.failoverFailure || params.failoverReason !== null)) ||
        (params.timedOut && !params.timedOutDuringCompaction));
}
export function mergeRetryFailoverReason(params) {
    return params.failoverReason ?? (params.timedOut ? "timeout" : null) ?? params.previous;
}
export function resolveRunFailoverDecision(params) {
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
        if (params.fallbackConfigured && params.failoverFailure) {
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
    if (params.externalAbort) {
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
            reason: params.timedOut ? "timeout" : (params.failoverReason ?? "unknown"),
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
