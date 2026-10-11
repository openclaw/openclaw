import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
} from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: Pick<RuntimeEnv, "error">;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

function formatTransportDiagnostics(error: unknown): string {
  const fields: { code?: string; syscall?: string } = {};
  for (const candidate of collectErrorGraphCandidates(error, (current) => [
    current.cause,
    current.error,
    current.reason,
    ...(Array.isArray(current.errors) ? current.errors : []),
  ])) {
    const code = extractErrorCode(candidate);
    if (!fields.code && code && /^(?:E[A-Z0-9_]{1,63}|UND_ERR_[A-Z0-9_]{1,56})$/.test(code)) {
      fields.code = code;
    }
    const syscall = isRecord(candidate) ? candidate.syscall : undefined;
    if (
      !fields.syscall &&
      typeof syscall === "string" &&
      /^(?:connect|read|write|recv|send|recvfrom|sendto|getaddrinfo|getnameinfo)$/.test(syscall)
    ) {
      fields.syscall = syscall;
    }
  }
  return fields.code || fields.syscall ? ` transport=${JSON.stringify(fields)}` : "";
}

export async function withTelegramApiErrorLogging<T>(
  params: TelegramApiLoggingParams<T>,
): Promise<T> {
  const { operation, fn, runtime, logger, shouldLog } = params;
  try {
    return await fn();
  } catch (err) {
    if (!shouldLog || shouldLog(err)) {
      const transport = formatTransportDiagnostics(err);
      const errText = transport ? `network request failed${transport}` : formatErrorMessage(err);
      const log = logger ?? runtime?.error ?? ((message: string) => fallbackLogger.error(message));
      log(`telegram ${operation} failed: ${errText}`);
    }
    throw err;
  }
}
