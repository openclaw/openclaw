import { isMainThread, threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import {
  EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE,
  logEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";

function timedStages(stages: readonly (readonly [string, number])[], start: number, end: number) {
  let clock = start;
  const tracker = createStageTimingTracker(() => clock);
  for (const [name, time] of stages) {
    clock = time;
    tracker.mark(name);
  }
  clock = end;
  return tracker.snapshot();
}
const createLog = (trace = false) => ({ isEnabled: () => trace, warn: vi.fn(), trace: vi.fn() });

it.each([
  [9_999, 4_999, false, undefined],
  [10_000, 0, true, undefined],
  [10, 5_000, true, undefined],
  [2_000, 10, true, { totalThresholdMs: 2_000, stageThresholdMs: 1_000 }],
] as const)(
  "warns for slow summaries (total=%s, stage=%s)",
  (totalMs, durationMs, warn, thresholds) => {
    const log = createLog();
    logEmbeddedRunStageSummary(
      { totalMs, stages: [{ name: "auth", durationMs, elapsedMs: durationMs }] },
      log,
      () => "startup",
      thresholds,
    );
    expect(log.warn).toHaveBeenCalledTimes(warn ? 1 : 0);
    expect(log.trace).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "orchestration",
    10,
    36,
    [
      ["workspace", 12],
      ["harness-selection", 17],
      ["prepared-runtime", 28],
      ["runtime-context", 31],
      ["runtime-plugins", 31],
    ],
    "totalMs=26 stages=workspace:2ms@2ms,harness-selection:5ms@7ms,prepared-runtime:11ms@18ms,runtime-context:3ms@21ms,runtime-plugins:0ms@21ms",
  ],
  [
    "first-attempt dispatch",
    0,
    91,
    [
      [EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.workspace, 10],
      [EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.prompt, 40],
      [EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan, 90],
      [EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch, 91],
    ],
    "totalMs=91 stages=attempt-workspace:10ms@10ms,attempt-prompt:30ms@40ms,attempt-runtime-plan:50ms@90ms,attempt-dispatch:1ms@91ms",
  ],
] as const)("keeps %s stages ordered and cumulative", (_name, start, end, stages, expected) => {
  const log = createLog(true);
  logEmbeddedRunStageSummary(timedStages(stages, start, end), log, () => "startup");
  expect(log.trace).toHaveBeenCalledExactlyOnceWith(
    `startup pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} ${expected}`,
  );
});
