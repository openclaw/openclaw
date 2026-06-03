export type EmbeddedRunStageTiming = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

export type EmbeddedRunStageSummary = {
  totalMs: number;
  stages: EmbeddedRunStageTiming[];
};

export type EmbeddedRunStageTracker = {
  mark: (name: string) => void;
  snapshot: () => EmbeddedRunStageSummary;
};

export const EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE = {
  workspace: "attempt-workspace",
  prompt: "attempt-prompt",
  runtimePlan: "attempt-runtime-plan",
  dispatch: "attempt-dispatch",
} as const;

const EMBEDDED_RUN_STAGE_WARN_TOTAL_MS = 10_000;
const EMBEDDED_RUN_STAGE_WARN_STAGE_MS = 5_000;

/**
 * Tracks named embedded-run startup spans with both per-stage duration and
 * elapsed time from tracker creation.
 */
export function createEmbeddedRunStageTracker(options?: {
  now?: () => number;
}): EmbeddedRunStageTracker {
  const now = options?.now ?? Date.now;
  const startedAt = now();
  let previousAt = startedAt;
  const stages: EmbeddedRunStageTiming[] = [];

  // Clamp synthetic or system-clock regressions so diagnostics never report
  // negative stage durations.
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
 * Decides whether an embedded-run stage summary is slow enough to emit a
 * warning-level diagnostic.
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
 * Formats stage timings into the compact one-line shape used by startup logs.
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
