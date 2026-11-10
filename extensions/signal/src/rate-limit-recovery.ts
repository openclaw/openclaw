import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Structured facts signal-cli puts in a JSON-RPC error's `data` (not `message`).
 * From `SignalJsonRpcCommandHandler#getErrorDataNode`:
 *   data: { response: { timestamp, results: [{ type, retryAfterSeconds?, token? }] } }
 * Only the non-personal recovery facts are surfaced here: retry timing and
 * whether a captcha proof is required. Tokens and recipient data are never
 * echoed, matching the socket transport's no-raw-remote-text rule.
 */
export type SignalRateLimitRecovery = {
  retryAfterSeconds?: number;
  captchaRequired: boolean;
};

const RATE_LIMIT_FAILURE = "RATE_LIMIT_FAILURE";

function rateLimitResults(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data)) {
    return [];
  }
  const response = data.response;
  if (!isRecord(response) || !Array.isArray(response.results)) {
    return [];
  }
  return response.results.filter(isRecord);
}

export function readSignalRateLimitRecovery(data: unknown): SignalRateLimitRecovery | null {
  const failures = rateLimitResults(data).filter((result) => result.type === RATE_LIMIT_FAILURE);
  if (failures.length === 0) {
    return null;
  }
  const retryAfterSeconds = failures.reduce<number | undefined>((largest, result) => {
    const value = asPositiveFiniteNumber(result.retryAfterSeconds);
    if (value === undefined) {
      return largest;
    }
    return largest === undefined || value > largest ? value : largest;
  }, undefined);
  const captchaRequired = failures.some((result) => typeof result.token === "string");
  return {
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    captchaRequired,
  };
}

/**
 * Append validated recovery guidance to a generic Signal RPC error message.
 * Returns `fallbackMessage` unchanged when the envelope carries no rate limit.
 */
export function describeSignalRateLimitRecovery(data: unknown, fallbackMessage: string): string {
  const recovery = readSignalRateLimitRecovery(data);
  if (!recovery) {
    return fallbackMessage;
  }
  const guidance: string[] = [];
  if (recovery.retryAfterSeconds !== undefined) {
    const seconds = Math.ceil(recovery.retryAfterSeconds);
    guidance.push(`retry after ${seconds}s`);
  }
  if (recovery.captchaRequired) {
    guidance.push(
      "captcha proof required; run `signal-cli submitRateLimitChallenge` before sending again",
    );
  }
  if (guidance.length === 0) {
    return `${fallbackMessage} (rate limited)`;
  }
  return `${fallbackMessage} (rate limited: ${guidance.join("; ")})`;
}
