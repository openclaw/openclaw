import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { EmbeddedPiExecutionContract } from "../../../config/types.agent-defaults.js";
import type { EmbeddedRunLivenessState } from "../types.js";
import type { EmbeddedRunAttemptResult } from "./types.js";
type ReplayMetadataAttempt = Pick<EmbeddedRunAttemptResult, "toolMetas" | "didSendViaMessagingTool" | "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "successfulCronAdds"> & Partial<Pick<EmbeddedRunAttemptResult, "messagingToolSentTargets">>;
type IncompleteTurnAttempt = Pick<EmbeddedRunAttemptResult, "assistantTexts" | "clientToolCalls" | "currentAttemptAssistant" | "yieldDetected" | "didSendDeterministicApprovalPrompt" | "didSendViaMessagingTool" | "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets" | "lastToolError" | "lastAssistant" | "replayMetadata" | "promptErrorSource" | "timedOutDuringCompaction">;
type PlanningOnlyAttempt = Pick<EmbeddedRunAttemptResult, "assistantTexts" | "clientToolCalls" | "yieldDetected" | "didSendDeterministicApprovalPrompt" | "didSendViaMessagingTool" | "lastToolError" | "lastAssistant" | "itemLifecycle" | "replayMetadata" | "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets" | "toolMetas">;
type SilentToolResultAttempt = Pick<EmbeddedRunAttemptResult, "clientToolCalls" | "yieldDetected" | "didSendDeterministicApprovalPrompt" | "lastToolError" | "messagesSnapshot" | "toolMetas">;
type RunLivenessAttempt = Pick<EmbeddedRunAttemptResult, "lastAssistant" | "promptErrorSource" | "replayMetadata" | "timedOutDuringCompaction">;
export declare function isIncompleteTerminalAssistantTurn(params: {
    hasAssistantVisibleText: boolean;
    lastAssistant?: {
        stopReason?: string;
    } | null;
}): boolean;
export declare const DEFAULT_REASONING_ONLY_RETRY_LIMIT = 2;
export declare const DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT = 1;
export declare const PLANNING_ONLY_RETRY_INSTRUCTION = "The previous assistant turn only described the plan. Do not restate the plan. Act now: take the first concrete tool action you can. If a real blocker prevents action, reply with the exact blocker in one sentence.";
export declare const REASONING_ONLY_RETRY_INSTRUCTION = "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";
export declare const EMPTY_RESPONSE_RETRY_INSTRUCTION = "The previous attempt did not produce a user-visible answer. Continue from the current state and produce the visible answer now. Do not restart from scratch.";
export declare const ACK_EXECUTION_FAST_PATH_INSTRUCTION = "The latest user message is a short approval to proceed. Do not recap or restate the plan. Start with the first concrete tool action immediately. Keep any user-facing follow-up brief and natural.";
export declare const STRICT_AGENTIC_BLOCKED_TEXT = "Agent stopped after repeated plan-only turns without taking a concrete action. No concrete tool action or external side effect advanced the task.";
export type PlanningOnlyPlanDetails = {
    explanation: string;
    steps: string[];
};
export declare function buildAttemptReplayMetadata(params: ReplayMetadataAttempt): EmbeddedRunAttemptResult["replayMetadata"];
export declare function resolveAttemptReplayMetadata(attempt: {
    replayMetadata?: EmbeddedRunAttemptResult["replayMetadata"] | null;
}): EmbeddedRunAttemptResult["replayMetadata"];
export declare function resolveIncompleteTurnPayloadText(params: {
    payloadCount: number;
    aborted: boolean;
    timedOut: boolean;
    attempt: IncompleteTurnAttempt;
}): string | null;
export declare function resolveSilentToolResultReplyPayload(params: {
    isCronTrigger: boolean;
    payloadCount: number;
    aborted: boolean;
    timedOut: boolean;
    attempt: SilentToolResultAttempt;
}): {
    text: typeof SILENT_REPLY_TOKEN;
} | null;
export declare function resolveReplayInvalidFlag(params: {
    attempt: RunLivenessAttempt;
    incompleteTurnText?: string | null;
}): boolean;
export declare function resolveRunLivenessState(params: {
    payloadCount: number;
    aborted: boolean;
    timedOut: boolean;
    attempt: RunLivenessAttempt;
    incompleteTurnText?: string | null;
}): EmbeddedRunLivenessState;
export declare function shouldTreatEmptyAssistantReplyAsSilent(params: {
    allowEmptyAssistantReplyAsSilent?: boolean;
    payloadCount: number;
    aborted: boolean;
    timedOut: boolean;
    attempt: IncompleteTurnAttempt;
}): boolean;
export declare function resolveReasoningOnlyRetryInstruction(params: {
    provider?: string;
    modelId?: string;
    modelApi?: string;
    executionContract?: string;
    aborted: boolean;
    timedOut: boolean;
    attempt: IncompleteTurnAttempt;
}): string | null;
export declare function resolveEmptyResponseRetryInstruction(params: {
    provider?: string;
    modelId?: string;
    modelApi?: string;
    executionContract?: string;
    payloadCount: number;
    aborted: boolean;
    timedOut: boolean;
    attempt: IncompleteTurnAttempt;
}): string | null;
export declare function isLikelyExecutionAckPrompt(text: string): boolean;
export declare function resolveAckExecutionFastPathInstruction(params: {
    provider?: string;
    modelId?: string;
    prompt: string;
}): string | null;
export declare function extractPlanningOnlyPlanDetails(text: string): PlanningOnlyPlanDetails | null;
export declare function resolvePlanningOnlyRetryLimit(executionContract?: EmbeddedPiExecutionContract): number;
export declare function resolvePlanningOnlyRetryInstruction(params: {
    provider?: string;
    modelId?: string;
    executionContract?: string;
    prompt?: string;
    aborted: boolean;
    timedOut: boolean;
    attempt: PlanningOnlyAttempt;
}): string | null;
export {};
