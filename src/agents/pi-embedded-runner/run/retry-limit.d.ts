import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "../types.js";
import type { RetryLimitFailoverDecision } from "./failover-policy.js";
export declare function handleRetryLimitExhaustion(params: {
    message: string;
    decision: RetryLimitFailoverDecision;
    provider: string;
    model: string;
    profileId?: string;
    durationMs: number;
    agentMeta: EmbeddedPiAgentMeta;
    replayInvalid?: boolean;
    livenessState?: EmbeddedRunLivenessState;
}): EmbeddedPiRunResult;
