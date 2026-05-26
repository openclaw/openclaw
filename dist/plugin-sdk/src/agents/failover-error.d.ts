import type { FailoverReason } from "./pi-embedded-helpers/types.js";
export declare class FailoverError extends Error {
    readonly reason: FailoverReason;
    readonly provider?: string;
    readonly model?: string;
    readonly profileId?: string;
    readonly status?: number;
    readonly code?: string;
    readonly rawError?: string;
    readonly sessionId?: string;
    readonly lane?: string;
    readonly suspend?: boolean;
    constructor(message: string, params: {
        reason: FailoverReason;
        provider?: string;
        model?: string;
        profileId?: string;
        status?: number;
        code?: string;
        rawError?: string;
        sessionId?: string;
        lane?: string;
        cause?: unknown;
        suspend?: boolean;
    });
}
export declare function isFailoverError(err: unknown): err is FailoverError;
export declare function resolveFailoverStatus(reason: FailoverReason): number | undefined;
/**
 * True when the error is a local runtime coordination error (session write-lock
 * timeout or embedded attempt session takeover) rather than a provider/model
 * failure. The model fallback chain must abort on these instead of consuming
 * candidate slots — retrying any model would hit the same local condition.
 * See #83510.
 */
export declare function isNonProviderRuntimeCoordinationError(err: unknown): boolean;
export declare function isTimeoutError(err: unknown): boolean;
export declare function resolveFailoverReasonFromError(err: unknown, providerHint?: string): FailoverReason | null;
export declare function describeFailoverError(err: unknown): {
    message: string;
    rawError?: string;
    reason?: FailoverReason;
    status?: number;
    code?: string;
    provider?: string;
    model?: string;
    profileId?: string;
    sessionId?: string;
    lane?: string;
};
export declare function coerceToFailoverError(err: unknown, context?: {
    provider?: string;
    model?: string;
    profileId?: string;
    sessionId?: string;
    lane?: string;
}): FailoverError | null;
