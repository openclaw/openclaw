/**
 * Subagent run timeout math.
 *
 * Separates timer-safe delays from duration/deadline values because setTimeout has stricter bounds.
 */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRunDeadlineRecord = Pick<
  SubagentRunRecord,
  "collect" | "createdAt" | "runTimeoutSeconds"
> & {
  execution: Pick<SubagentRunRecord["execution"], "startedAt">;
};

export function resolveSubagentRunDurationMs(timeoutSeconds: unknown): number | undefined {
  if (
    typeof timeoutSeconds !== "number" ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    return undefined;
  }
  const durationMs = Math.floor(timeoutSeconds) * 1000;
  return Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : undefined;
}

export function resolveSubagentRunDeadlineMs(
  entry: SubagentRunDeadlineRecord,
  observedStartedAt?: number,
): number | undefined {
  const durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);
  if (durationMs === undefined) {
    return undefined;
  }
  const startedAt =
    typeof observedStartedAt === "number" && Number.isFinite(observedStartedAt)
      ? observedStartedAt
      : typeof entry.execution.startedAt === "number" && Number.isFinite(entry.execution.startedAt)
        ? entry.execution.startedAt
        : entry.collect
          ? undefined
          : entry.createdAt;
  const safeStartedAt = asDateTimestampMs(startedAt);
  if (safeStartedAt === undefined) {
    return undefined;
  }
  const deadlineMs = safeStartedAt + durationMs;
  return Number.isSafeInteger(deadlineMs) && asDateTimestampMs(deadlineMs) !== undefined
    ? deadlineMs
    : undefined;
}

export function resolveSubagentRunEffectiveEndedAt(
  entry: SubagentRunDeadlineRecord,
  endedAt: number,
  observedStartedAt?: number,
): number {
  const deadlineMs = resolveSubagentRunDeadlineMs(entry, observedStartedAt);
  return deadlineMs !== undefined && endedAt > deadlineMs ? deadlineMs : endedAt;
}
