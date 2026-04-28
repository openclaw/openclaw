import { isRecord } from "../../utils.js";

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

export type AcpRpcErrorPayload = {
  code: number;
  message: string;
  data?: unknown;
};

function toAcpRpcErrorPayload(value: unknown): AcpRpcErrorPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.code !== "number" || !Number.isFinite(value.code)) {
    return undefined;
  }
  if (typeof value.message !== "string" || value.message.length === 0) {
    return undefined;
  }
  return {
    code: value.code,
    message: value.message,
    data: value.data,
  };
}

// Mirrors the recursive walker in acpx/src/acp/error-shapes.ts (private upstream).
// Walks `.error`, `.acp`, `.cause` to find the first JSON-RPC-shaped payload so
// callers can surface the real backend detail instead of an opaque wrapper.
export function extractAcpRpcError(value: unknown, depth = 0): AcpRpcErrorPayload | undefined {
  if (depth > 5) {
    return undefined;
  }
  const direct = toAcpRpcErrorPayload(value);
  if (direct) {
    return direct;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if ("error" in value) {
    const nested = extractAcpRpcError(value.error, depth + 1);
    if (nested) {
      return nested;
    }
  }
  if ("acp" in value) {
    const nested = extractAcpRpcError(value.acp, depth + 1);
    if (nested) {
      return nested;
    }
  }
  if ("cause" in value) {
    const nested = extractAcpRpcError(value.cause, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

export function describeAcpRpcError(err: unknown): string {
  const payload = extractAcpRpcError(err);
  if (payload) {
    const data = payload.data;
    const details = isRecord(data) && typeof data.details === "string" ? data.details.trim() : "";
    const detail = details.length > 0 ? details : payload.message;
    return `${detail} (acp ${payload.code})`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
