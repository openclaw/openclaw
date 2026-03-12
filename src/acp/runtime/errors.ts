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

export function normalizeAcpDiagnosticText(value: unknown, maxLength = 400): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

export function describeAcpErrorForLog(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  let depth = 0;

  while (current && depth < 4 && !seen.has(current)) {
    seen.add(current);
    const prefix = depth === 0 ? "error" : `cause${depth}`;
    if (current instanceof Error) {
      const currentRecord = current as unknown as {
        code?: unknown;
        stderr?: unknown;
        stdout?: unknown;
        details?: unknown;
      };
      if (typeof current.name === "string" && current.name !== "Error") {
        parts.push(`${prefix}.name=${current.name}`);
      }
      const code = typeof currentRecord.code === "string" ? currentRecord.code.trim() : "";
      if (code) {
        parts.push(`${prefix}.code=${code}`);
      }
      const message = normalizeAcpDiagnosticText(current.message, 500);
      if (message) {
        parts.push(`${prefix}.message=${JSON.stringify(message)}`);
      }
      const stderr = normalizeAcpDiagnosticText(currentRecord.stderr, 500);
      if (stderr) {
        parts.push(`${prefix}.stderr=${JSON.stringify(stderr)}`);
      }
      const stdout = normalizeAcpDiagnosticText(currentRecord.stdout, 500);
      if (stdout) {
        parts.push(`${prefix}.stdout=${JSON.stringify(stdout)}`);
      }
      const details =
        typeof currentRecord.details === "object" && currentRecord.details !== null
          ? (currentRecord.details as Record<string, unknown>)
          : undefined;
      const detailsStderr = normalizeAcpDiagnosticText(details?.stderr, 500);
      if (detailsStderr) {
        parts.push(`${prefix}.details.stderr=${JSON.stringify(detailsStderr)}`);
      }
      const detailsStdout = normalizeAcpDiagnosticText(details?.stdout, 500);
      if (detailsStdout) {
        parts.push(`${prefix}.details.stdout=${JSON.stringify(detailsStdout)}`);
      }
      current = current.cause;
    } else if (typeof current === "object") {
      const code =
        typeof (current as { code?: unknown }).code === "string"
          ? (current as { code: string }).code.trim()
          : "";
      if (code) {
        parts.push(`${prefix}.code=${code}`);
      }
      const stderr = normalizeAcpDiagnosticText((current as { stderr?: unknown }).stderr, 500);
      if (stderr) {
        parts.push(`${prefix}.stderr=${JSON.stringify(stderr)}`);
      }
      const stdout = normalizeAcpDiagnosticText((current as { stdout?: unknown }).stdout, 500);
      if (stdout) {
        parts.push(`${prefix}.stdout=${JSON.stringify(stdout)}`);
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      const text = normalizeAcpDiagnosticText(
        typeof current === "string"
          ? current
          : typeof current === "number" || typeof current === "boolean"
            ? JSON.stringify(current)
            : typeof current === "bigint" || typeof current === "symbol"
              ? String(current)
              : typeof current,
        500,
      );
      if (text) {
        parts.push(`${prefix}=${JSON.stringify(text)}`);
      }
      break;
    }
    depth += 1;
  }

  return parts.join(" ");
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
