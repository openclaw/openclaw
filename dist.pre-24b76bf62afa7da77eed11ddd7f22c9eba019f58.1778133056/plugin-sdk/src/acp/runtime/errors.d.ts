export declare const ACP_ERROR_CODES: readonly ["ACP_BACKEND_MISSING", "ACP_BACKEND_UNAVAILABLE", "ACP_BACKEND_UNSUPPORTED_CONTROL", "ACP_DISPATCH_DISABLED", "ACP_INVALID_RUNTIME_OPTION", "ACP_SESSION_INIT_FAILED", "ACP_TURN_FAILED"];
export type AcpRuntimeErrorCode = (typeof ACP_ERROR_CODES)[number];
export declare class AcpRuntimeError extends Error {
    readonly code: AcpRuntimeErrorCode;
    readonly cause?: unknown;
    constructor(code: AcpRuntimeErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export declare function isAcpRuntimeError(value: unknown): value is AcpRuntimeError;
export declare function toAcpRuntimeError(params: {
    error: unknown;
    fallbackCode: AcpRuntimeErrorCode;
    fallbackMessage: string;
}): AcpRuntimeError;
export declare function withAcpRuntimeErrorBoundary<T>(params: {
    run: () => Promise<T>;
    fallbackCode: AcpRuntimeErrorCode;
    fallbackMessage: string;
}): Promise<T>;
