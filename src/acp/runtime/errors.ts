export const ACP_ERROR_CODES = [
  "ACP_BACKEND_MISSING",
  "ACP_BACKEND_UNAVAILABLE",
  "ACP_BACKEND_UNSUPPORTED_CONTROL",
  "ACP_DISPATCH_DISABLED",
  "ACP_INVALID_RUNTIME_OPTION",
  "ACP_SESSION_INIT_FAILED",
  "ACP_TURN_FAILED",
] as const;

export type AcpRuntimeErrorCode = (typeof ACP_ERROR_CODES)[number];

export class AcpRuntimeError extends Error {
  readonly code: AcpRuntimeErrorCode;
  override readonly cause?: unknown;

  constructor(code: AcpRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AcpRuntimeError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export function isAcpRuntimeError(value: unknown): value is AcpRuntimeError {
  return value instanceof AcpRuntimeError;
}

export function toAcpRuntimeError(params: {
  error: unknown;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): AcpRuntimeError {
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

export async function withAcpRuntimeErrorBoundary<T>(params: {
  run: () => Promise<T>;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    throw toAcpRuntimeError({
      error,
      fallbackCode: params.fallbackCode,
      fallbackMessage: params.fallbackMessage,
    });
  }
}
