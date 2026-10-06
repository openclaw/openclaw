/**
 * Subagent run timeout math.
 *
 * Separates timer-safe delays from duration/deadline values because setTimeout has stricter bounds.
 */
import { asDateTimestampMs, asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
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
    asFiniteNumber(observedStartedAt) ??
    asFiniteNumber(entry.execution.startedAt) ??
    (entry.collect ? undefined : entry.createdAt);
  const safeStartedAt = asDateTimestampMs(startedAt);
  if (safeStartedAt === undefined) {
    return undefined;
  }
  const deadlineMs = safeStartedAt + durationMs;
  return Number.isSafeInteger(deadlineMs) && asDateTimestampMs(deadlineMs) !== undefined
    ? deadlineMs
    : undefined;
}

export function resolveCompletionAfterHardRunDeadline(params: {
  entry: SubagentRunRecord;
  observedStartedAt?: number;
  observedEndedAt?: number;
  now: number;
}): number | undefined {
  const deadlineMs = resolveSubagentRunDeadlineMs(params.entry, params.observedStartedAt);
  if (deadlineMs === undefined) {
    return undefined;
  }
  const observedEndedAt = asFiniteNumber(params.observedEndedAt) ?? params.now;
  return observedEndedAt > deadlineMs ? deadlineMs : undefined;
}

export function resolveSubagentRunEffectiveEndedAt(
  entry: SubagentRunDeadlineRecord,
  endedAt: number,
  observedStartedAt?: number,
): number {
  const deadlineMs = resolveSubagentRunDeadlineMs(entry, observedStartedAt);
  return deadlineMs !== undefined && endedAt > deadlineMs ? deadlineMs : endedAt;
}

export function resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number) {
  return resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: runTimeoutSeconds ?? 0,
  });
}
