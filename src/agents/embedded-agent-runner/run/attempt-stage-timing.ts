/** Timing for one named embedded-run stage in a startup/dispatch timeline. */
export type EmbeddedRunStageTiming = {
  name: string;
  /** Time spent since the previous stage marker. */
  durationMs: number;
  /** Time since the tracker was created. */
  elapsedMs: number;
};

/** Snapshot of all completed stage markers plus current total elapsed time. */
export type EmbeddedRunStageSummary = {
  totalMs: number;
  stages: EmbeddedRunStageTiming[];
};

/** Small monotonic-style stage tracker used for slow embedded-run diagnostics. */
export type EmbeddedRunStageTracker = {
  mark: (name: string) => void;
  snapshot: () => EmbeddedRunStageSummary;
};

/**
 * Canonical first-attempt dispatch subspan names. Keeping these constants shared
 * makes slow-startup logs comparable across attempt.ts and tests.
 */
export const EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE = {
  workspace: "attempt-workspace",
  prompt: "attempt-prompt",
  runtimePlan: "attempt-runtime-plan",
  dispatch: "attempt-dispatch",
} as const;

const EMBEDDED_RUN_STAGE_WARN_TOTAL_MS = 10_000;
const EMBEDDED_RUN_STAGE_WARN_STAGE_MS = 5_000;

/**
 * Creates a lightweight elapsed/delta tracker for embedded-run startup stages.
 * Values are rounded and clamped at zero so low-resolution or slightly skewed
 * clocks do not produce noisy negative durations in logs.
 */
export function createEmbeddedRunStageTracker(options?: {
  now?: () => number;
}): EmbeddedRunStageTracker {
  const now = options?.now ?? Date.now;
  const startedAt = now();
  let previousAt = startedAt;
  const stages: EmbeddedRunStageTiming[] = [];

  const toMs = (value: number) => Math.max(0, Math.round(value));

  return {
    mark(name) {
      const currentAt = now();
      stages.push({
        name,
        durationMs: toMs(currentAt - previousAt),
        elapsedMs: toMs(currentAt - startedAt),
      });
      previousAt = currentAt;
    },
    snapshot() {
      return {
        totalMs: toMs(now() - startedAt),
        stages: stages.slice(),
      };
    },
  };
}

/**
 * Decides whether a stage summary is slow enough to log. The default thresholds
 * catch either a slow total startup path or one isolated stage that dominates
 * startup latency.
 */
export function shouldWarnEmbeddedRunStageSummary(
  summary: EmbeddedRunStageSummary,
  options?: {
    totalThresholdMs?: number;
    stageThresholdMs?: number;
  },
): boolean {
  const totalThresholdMs = options?.totalThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_TOTAL_MS;
  const stageThresholdMs = options?.stageThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_STAGE_MS;
  return (
    summary.totalMs >= totalThresholdMs ||
    summary.stages.some((stage) => stage.durationMs >= stageThresholdMs)
  );
}

/**
 * Formats timing summaries as a compact single log field. The `duration@elapsed`
 * shape keeps each stage's local cost and timeline position visible without
 * structured log expansion.
 */
export function formatEmbeddedRunStageSummary(
  prefix: string,
  summary: EmbeddedRunStageSummary,
): string {
  const stages =
    summary.stages.length > 0
      ? summary.stages
          .map((stage) => `${stage.name}:${stage.durationMs}ms@${stage.elapsedMs}ms`)
          .join(",")
      : "none";
  return `${prefix} totalMs=${summary.totalMs} stages=${stages}`;
}
