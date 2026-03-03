export const ACP_ERROR_CODES = [
    "ACP_BACKEND_MISSING",
    "ACP_BACKEND_UNAVAILABLE",
    "ACP_BACKEND_UNSUPPORTED_CONTROL",
    "ACP_DISPATCH_DISABLED",
    "ACP_INVALID_RUNTIME_OPTION",
    "ACP_SESSION_INIT_FAILED",
    "ACP_TURN_FAILED",
];
export class AcpRuntimeError extends Error {
    code;
    cause;
    constructor(code, message, options) {
        super(message);
        this.name = "AcpRuntimeError";
        this.code = code;
        this.cause = options?.cause;
    }
}
export function isAcpRuntimeError(value) {
    return value instanceof AcpRuntimeError;
}
export function toAcpRuntimeError(params) {
    if (params.error instanceof AcpRuntimeError) {
        return params.error;
    }
    if (params.error instanceof Error) {
        return new AcpRuntimeError(params.fallbackCode, params.error.message, {
            cause: params.error,
        });
    }
    return new AcpRuntimeError(params.fallbackCode, params.fallbackMessage, {
        cause: params.error,
    });
}
export async function withAcpRuntimeErrorBoundary(params) {
    try {
        return await params.run();
    }
    catch (error) {
        throw toAcpRuntimeError({
            error,
            fallbackCode: params.fallbackCode,
            fallbackMessage: params.fallbackMessage,
        });
    }
}
