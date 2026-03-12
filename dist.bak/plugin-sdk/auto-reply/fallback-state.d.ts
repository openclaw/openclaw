import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeFallbackAttempt } from "./reply/agent-runner-execution.js";
export type FallbackNoticeState = Pick<SessionEntry, "fallbackNoticeSelectedModel" | "fallbackNoticeActiveModel" | "fallbackNoticeReason">;
export declare function normalizeFallbackModelRef(value?: string): string | undefined;
export declare function formatFallbackAttemptReason(attempt: RuntimeFallbackAttempt): string;
export declare function buildFallbackReasonSummary(attempts: RuntimeFallbackAttempt[]): string;
export declare function buildFallbackAttemptSummaries(attempts: RuntimeFallbackAttempt[]): string[];
export declare function buildFallbackNotice(params: {
    selectedProvider: string;
    selectedModel: string;
    activeProvider: string;
    activeModel: string;
    attempts: RuntimeFallbackAttempt[];
}): string | null;
export declare function buildFallbackClearedNotice(params: {
    selectedProvider: string;
    selectedModel: string;
    previousActiveModel?: string;
}): string;
export declare function resolveActiveFallbackState(params: {
    selectedModelRef: string;
    activeModelRef: string;
    state?: FallbackNoticeState;
}): {
    active: boolean;
    reason?: string;
};
export type ResolvedFallbackTransition = {
    selectedModelRef: string;
    activeModelRef: string;
    fallbackActive: boolean;
    fallbackTransitioned: boolean;
    fallbackCleared: boolean;
    reasonSummary: string;
    attemptSummaries: string[];
    previousState: {
        selectedModel?: string;
        activeModel?: string;
        reason?: string;
    };
    nextState: {
        selectedModel?: string;
        activeModel?: string;
        reason?: string;
    };
    stateChanged: boolean;
};
export declare function resolveFallbackTransition(params: {
    selectedProvider: string;
    selectedModel: string;
    activeProvider: string;
    activeModel: string;
    attempts: RuntimeFallbackAttempt[];
    state?: FallbackNoticeState;
}): ResolvedFallbackTransition;
