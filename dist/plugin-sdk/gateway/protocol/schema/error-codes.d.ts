import type { ErrorShape } from "./types.js";
export declare const ErrorCodes: {
    readonly NOT_LINKED: "NOT_LINKED";
    readonly NOT_PAIRED: "NOT_PAIRED";
    readonly AGENT_TIMEOUT: "AGENT_TIMEOUT";
    readonly INVALID_REQUEST: "INVALID_REQUEST";
    readonly UNAVAILABLE: "UNAVAILABLE";
};
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
export declare function errorShape(code: ErrorCode, message: string, opts?: {
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
}): ErrorShape;
