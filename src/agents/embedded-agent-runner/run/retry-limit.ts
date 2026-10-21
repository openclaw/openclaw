import { sanitizeAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import type {
  EmbeddedRunLivenessState,
  EmbeddedAgentMeta,
  EmbeddedAgentRunResult,
} from "../types.js";
import type { RetryLimitFailoverDecision } from "./failover-policy.js";

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
  const text =
    "Request failed after repeated internal retries. " +
    "Please try again, or use /new to start a fresh session.";

  return {
    payloads: [
      {
        text,
        isError: true,
      },
    ],
    meta: {
      durationMs: params.durationMs,
      agentMeta: params.agentMeta,
      terminalReply: sanitizeAgentRunTerminalReply(text),
      finalAssistantVisibleText: text,
      ...(params.replayInvalid ? { replayInvalid: true } : {}),
      ...(params.livenessState ? { livenessState: params.livenessState } : {}),
      error: { kind: "retry_limit", message: params.message },
    },
  };
}
