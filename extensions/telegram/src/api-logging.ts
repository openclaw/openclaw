import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

type TelegramApiLogger = (message: string) => void;

type TelegramApiLoggingParams<T> = {
  operation: string;
  fn: () => Promise<T>;
  runtime?: Pick<RuntimeEnv, "error">;
  logger?: TelegramApiLogger;
  shouldLog?: (err: unknown) => boolean;
};

const fallbackLogger = createSubsystemLogger("telegram/api");

export async function withTelegramApiErrorLogging<T>(
  params: TelegramApiLoggingParams<T>,
): Promise<T> {
  const { operation, fn, runtime, logger, shouldLog } = params;
  try {
    return await fn();
  } catch (err) {
    if (!shouldLog || shouldLog(err)) {
      const errText = formatErrorMessage(err);
      const log = logger ?? runtime?.error ?? ((message: string) => fallbackLogger.error(message));
      log(`telegram ${operation} failed: ${errText}`);
    }
    throw err;
  }
}
