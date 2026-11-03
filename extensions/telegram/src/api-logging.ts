import { GrammyError, HttpError } from "grammy";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
} from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: Pick<RuntimeEnv, "error">;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

/** Ends the description of the synthetic 429 the account limiter returns for a request it held back. */
export const TELEGRAM_UNSENT_FLOOD_SUFFIX = "; request not sent)";

/** True when the account limiter held the request back, so it never reached Telegram. */
function isTelegramUnsentFloodError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 429 &&
    err.description.endsWith(TELEGRAM_UNSENT_FLOOD_SUFFIX)
  );
}

export function formatTelegramTransportDiagnostics(error: unknown): string {
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
  const { operation, fn, runtime, shouldLog } = params;
  try {
    return await fn();
  } catch (err) {
    // The limiter already warned once about the flood wait that held this request back.
    if (!isTelegramUnsentFloodError(err) && (!shouldLog || shouldLog(err))) {
      const transport = formatTelegramTransportDiagnostics(err);
      const errText =
        err instanceof HttpError || transport
          ? `network request failed${transport}`
          : formatErrorMessage(err);
      const log = runtime?.error ?? ((message: string) => fallbackLogger.error(message));
      log(`telegram ${operation} failed: ${errText}`);
    }
    throw err;
  }
}
