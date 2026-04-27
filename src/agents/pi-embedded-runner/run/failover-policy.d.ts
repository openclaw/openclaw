import type { FailoverReason } from "../../pi-embedded-helpers.js";
export type RunFailoverDecisionAction = "continue_normal" | "rotate_profile" | "fallback_model" | "surface_error" | "return_error_payload";
export type RunFailoverDecision = {
    action: "continue_normal";
} | {
    action: "rotate_profile" | "surface_error";
    reason: FailoverReason | null;
} | {
    action: "fallback_model";
    reason: FailoverReason;
} | {
    action: "return_error_payload";
};
export type RetryLimitFailoverDecision = Extract<RunFailoverDecision, {
    action: "fallback_model" | "return_error_payload";
}>;
export type PromptFailoverDecision = Extract<RunFailoverDecision, {
    action: "rotate_profile" | "fallback_model" | "surface_error";
}>;
export type AssistantFailoverDecision = Extract<RunFailoverDecision, {
    action: "continue_normal" | "rotate_profile" | "fallback_model" | "surface_error";
}>;
type RetryLimitDecisionParams = {
    stage: "retry_limit";
    fallbackConfigured: boolean;
    failoverReason: FailoverReason | null;
};
type PromptDecisionParams = {
    stage: "prompt";
    aborted: boolean;
    externalAbort: boolean;
    fallbackConfigured: boolean;
    failoverFailure: boolean;
    failoverReason: FailoverReason | null;
    profileRotated: boolean;
};
type AssistantDecisionParams = {
    stage: "assistant";
    aborted: boolean;
    externalAbort: boolean;
    fallbackConfigured: boolean;
    failoverFailure: boolean;
    failoverReason: FailoverReason | null;
    timedOut: boolean;
    timedOutDuringCompaction: boolean;
    profileRotated: boolean;
};
export type RunFailoverDecisionParams = RetryLimitDecisionParams | PromptDecisionParams | AssistantDecisionParams;
export declare function mergeRetryFailoverReason(params: {
    previous: FailoverReason | null;
    failoverReason: FailoverReason | null;
    timedOut?: boolean;
}): FailoverReason | null;
export declare function resolveRunFailoverDecision(params: RetryLimitDecisionParams): RetryLimitFailoverDecision;
export declare function resolveRunFailoverDecision(params: PromptDecisionParams): PromptFailoverDecision;
export declare function resolveRunFailoverDecision(params: AssistantDecisionParams): AssistantFailoverDecision;
export {};
