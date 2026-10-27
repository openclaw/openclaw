import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";

export function resolveQaGatewayTimeoutWithGraceMs(timeoutMs: unknown): number | undefined {
  const timeout = clampPositiveTimerTimeoutMs(timeoutMs);
  if (timeout === undefined) {
    return undefined;
  }
  return addTimerTimeoutGraceMs(timeout, 5_000);
}
