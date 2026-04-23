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
const ACP_ERROR_CODE_SET = new Set<AcpRuntimeErrorCode>(ACP_ERROR_CODES);

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

function getForeignAcpRuntimeError(value: unknown): {
  code: AcpRuntimeErrorCode;
  message: string;
} | null {
  if (!(value instanceof Error)) {
    return null;
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code !== "string" || !ACP_ERROR_CODE_SET.has(code as AcpRuntimeErrorCode)) {
    return null;
  }
  return {
    code: code as AcpRuntimeErrorCode,
    message: value.message,
  };
}

export function isAcpRuntimeError(value: unknown): value is AcpRuntimeError {
  return value instanceof AcpRuntimeError || getForeignAcpRuntimeError(value) !== null;
}

export function toAcpRuntimeError(params: {
  error: unknown;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): AcpRuntimeError {
  if (params.error instanceof AcpRuntimeError) {
    return params.error;
  }
  const foreignAcpRuntimeError = getForeignAcpRuntimeError(params.error);
  if (foreignAcpRuntimeError) {
    return new AcpRuntimeError(foreignAcpRuntimeError.code, foreignAcpRuntimeError.message, {
      cause: params.error,
    });
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
