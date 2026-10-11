import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import {
  type createStageTimingTracker,
  formatStageTimings,
  type StageTimingSummary,
} from "../../../shared/stage-timing.js";

export const EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE = {
  workspace: "attempt-workspace",
  prompt: "attempt-prompt",
  runtimePlan: "attempt-runtime-plan",
  dispatch: "attempt-dispatch",
} as const;

const EMBEDDED_RUN_STAGE_WARN_TOTAL_MS = 10_000;
const EMBEDDED_RUN_STAGE_WARN_STAGE_MS = 5_000;

export function shouldWarnEmbeddedRunStageSummary(
  summary: StageTimingSummary,
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

export function createEmbeddedRunStageSummaryEmitter(options: {
  label: string;
  log: {
    isEnabled: (level: "trace") => boolean;
    warn: (message: string) => void;
    trace: (message: string) => void;
  };
  runId: string;
  sessionId?: string;
  tracker: ReturnType<typeof createStageTimingTracker>;
}): (phase: string) => void {
  return (phase) =>
    logEmbeddedRunStageSummary(
      options.tracker.snapshot(),
      options.log,
      () =>
        `[trace:embedded-run] ${options.label}: runId=${options.runId} sessionId=${options.sessionId} phase=${phase}`,
    );
}

export function logEmbeddedRunStageSummary(
  summary: StageTimingSummary,
  log: Parameters<typeof createEmbeddedRunStageSummaryEmitter>[0]["log"],
  prefix: () => string,
  thresholds?: Parameters<typeof shouldWarnEmbeddedRunStageSummary>[1],
): void {
  const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary, thresholds);
  if (shouldWarn || log.isEnabled("trace")) {
    const message = formatEmbeddedRunStageSummary(prefix(), summary);
    log[shouldWarn ? "warn" : "trace"](message);
  }
}

export function formatEmbeddedRunStageSummary(prefix: string, summary: StageTimingSummary): string {
  const stages = formatStageTimings(summary.stages);
  return `${prefix} pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=${summary.totalMs} stages=${stages}`;
}

/**
 * Awaits `fn` and records its wall-clock duration under `name` via `record` in a
 * `finally`, so the recorded substage time includes the awaited work. A plain
 * sync wrapper that returns the promise would record ~0ms before the awaited
 * work settles, misleading the slow-bootstrap diagnostic.
 */
export async function measureBootstrapSubstage<T>(
  record: (name: string, durationMs: number) => void,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    record(name, performance.now() - startedAt);
  }
}
