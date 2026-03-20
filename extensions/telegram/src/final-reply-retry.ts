import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/infra-runtime";
import { isSafeToRetrySendError } from "./network-errors.js";

const TELEGRAM_FINAL_REPLY_RETRY_POLICY = {
  initialMs: 2_000,
  maxMs: 15_000,
  factor: 2,
  jitter: 0.2,
};

const TELEGRAM_FINAL_REPLY_MAX_ATTEMPTS = 4;

export async function retryTelegramPreConnectSend<T>(params: {
  deliver: () => Promise<T>;
  log?: (message: string) => void;
  operationLabel?: string;
  abortSignal?: AbortSignal;
}): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await params.deliver();
    } catch (err) {
      attempt += 1;
      if (!isSafeToRetrySendError(err) || attempt >= TELEGRAM_FINAL_REPLY_MAX_ATTEMPTS) {
        throw err;
      }
      const delayMs = computeBackoff(TELEGRAM_FINAL_REPLY_RETRY_POLICY, attempt);
      params.log?.(
        `telegram: ${params.operationLabel ?? "send"} failed before reaching Telegram; retrying in ${delayMs}ms (${String(err)})`,
      );
      await sleepWithAbort(delayMs, params.abortSignal);
    }
  }
}

export async function retryTelegramFinalReplyDelivery<T>(params: {
  deliver: () => Promise<T>;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
}): Promise<T> {
  return retryTelegramPreConnectSend({
    ...params,
    operationLabel: "final reply send",
  });
}
