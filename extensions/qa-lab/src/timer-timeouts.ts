import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";

export function resolveQaGatewayTimeoutWithGraceMs(
  timeoutMs: unknown,
  graceMs: unknown = 5_000,
): number | undefined {
  const timeout = clampPositiveTimerTimeoutMs(timeoutMs);
  if (timeout === undefined) {
    return undefined;
  }
  const grace = resolveTimerTimeoutMs(graceMs, 0, 0);
  return addTimerTimeoutGraceMs(timeout, grace);
}
