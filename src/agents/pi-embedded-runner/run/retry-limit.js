import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
export function handleRetryLimitExhaustion(params) {
    if (params.decision.action === "fallback_model") {
        throw new FailoverError(params.message, {
            reason: params.decision.reason,
            provider: params.provider,
            model: params.model,
            profileId: params.profileId,
            status: resolveFailoverStatus(params.decision.reason),
        });
    }
    return {
        payloads: [
            {
                text: "Request failed after repeated internal retries. " +
                    "Please try again, or use /new to start a fresh session.",
                isError: true,
            },
        ],
        meta: {
            durationMs: params.durationMs,
            agentMeta: params.agentMeta,
            ...(params.replayInvalid ? { replayInvalid: true } : {}),
            ...(params.livenessState ? { livenessState: params.livenessState } : {}),
            error: { kind: "retry_limit", message: params.message },
        },
    };
}
