import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import { FailoverError } from "../../failover-error.js";
import { type FailoverReason } from "../../pi-embedded-helpers.js";
import { type AssistantFailoverDecision } from "./failover-policy.js";
type AssistantFailoverOutcome = {
    action: "continue_normal";
    overloadProfileRotations: number;
} | {
    action: "retry";
    overloadProfileRotations: number;
    lastRetryFailoverReason: FailoverReason | null;
    retryKind?: "same_model_idle_timeout";
} | {
    action: "throw";
    overloadProfileRotations: number;
    error: FailoverError;
};
export declare function handleAssistantFailover(params: {
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
    activeErrorContext: {
        provider: string;
        model: string;
    };
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
    logAssistantFailoverDecision: (decision: "rotate_profile" | "fallback_model" | "surface_error", extra?: {
        status?: number;
    }) => void;
    warn: (message: string) => void;
    maybeMarkAuthProfileFailure: (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
        modelId?: string;
    }) => Promise<void>;
    maybeEscalateRateLimitProfileFallback: (params: {
        failoverProvider: string;
        failoverModel: string;
        logFallbackDecision: (decision: "fallback_model", extra?: {
            status?: number;
        }) => void;
    }) => void;
    maybeBackoffBeforeOverloadFailover: (reason: FailoverReason | null) => Promise<void>;
    advanceAuthProfile: () => Promise<boolean>;
}): Promise<AssistantFailoverOutcome>;
export {};
