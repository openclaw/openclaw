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
  return (phase) => {
    const summary = options.tracker.snapshot();
    const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary);
    if (!shouldWarn && !options.log.isEnabled("trace")) {
      return;
    }
    const message = formatEmbeddedRunStageSummary(
      `[trace:embedded-run] ${options.label}: runId=${options.runId} sessionId=${options.sessionId} phase=${phase}`,
      summary,
    );
    if (shouldWarn) {
      options.log.warn(message);
    } else {
      options.log.trace(message);
    }
  };
}

export function formatEmbeddedRunStageSummary(prefix: string, summary: StageTimingSummary): string {
  const stages = formatStageTimings(summary.stages);
  return `${prefix} pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=${summary.totalMs} stages=${stages}`;
}
