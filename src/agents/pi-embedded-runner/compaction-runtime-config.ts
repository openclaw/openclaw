import type { OpenClawConfig } from "../../config/types.openclaw.js";

export const DEFAULT_PREEMPTIVE_OVERFLOW_RATIO = 0.9;
export const DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolvePreemptiveOverflowRatio(config?: OpenClawConfig): number {
  const configured = asFiniteNumber(config?.agents?.defaults?.compaction?.preemptiveOverflowRatio);
  if (configured === undefined || configured <= 0 || configured >= 1) {
    return DEFAULT_PREEMPTIVE_OVERFLOW_RATIO;
  }
  return configured;
}

export function resolveMaxOverflowCompactionAttempts(config?: OpenClawConfig): number {
  const configured = asFiniteNumber(config?.agents?.defaults?.compaction?.maxOverflowAttempts);
  if (configured === undefined || configured < 0) {
    return DEFAULT_MAX_OVERFLOW_COMPACTION_ATTEMPTS;
  }
  return Math.floor(configured);
}
