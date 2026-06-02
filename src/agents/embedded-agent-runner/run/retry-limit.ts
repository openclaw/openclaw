import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedAgentMeta, EmbeddedAgentRunResult } from "../types.js";
import type { RetryLimitFailoverDecision } from "./failover-policy.js";

/**
 * Converts retry-limit exhaustion into either model failover or a final error
 * payload. Fallback decisions throw FailoverError so the outer run loop can
 * reuse its normal model-switch path; local exhaustion returns a user-visible
 * retry-limit payload with the latest agent metadata attached.
 */
export function handleRetryLimitExhaustion(params: {
  message: string;
  decision: RetryLimitFailoverDecision;
  provider: string;
  model: string;
  profileId?: string;
  durationMs: number;
  agentMeta: EmbeddedAgentMeta;
  replayInvalid?: boolean;
  livenessState?: EmbeddedRunLivenessState;
}): EmbeddedAgentRunResult {
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
        text:
          "Request failed after repeated internal retries. " +
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
