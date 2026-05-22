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
    });
}
export declare function isFailoverError(err: unknown): err is FailoverError;
export declare function resolveFailoverStatus(reason: FailoverReason): number | undefined;
export declare function isTimeoutError(err: unknown): boolean;
export declare function resolveFailoverReasonFromError(err: unknown): FailoverReason | null;
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
