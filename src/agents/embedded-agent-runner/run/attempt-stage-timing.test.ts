// Coverage for embedded attempt startup stage timing diagnostics.
import { isMainThread, threadId } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import {
  EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE,
  formatEmbeddedRunStageSummary,
  logEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";

describe("embedded run stage timing", () => {
  it("captures stage duration and elapsed time", () => {
    // Stage snapshots carry both local duration and total elapsed time so slow
    // startup logs can identify where time accumulated.
    let clock = 10;
    const tracker = createStageTimingTracker(() => clock);

    clock = 25;
    tracker.mark("workspace");
    clock = 40;
    tracker.mark("tools");
    clock = 45;

    expect(tracker.snapshot()).toEqual({
      totalMs: 35,
      stages: [
        { name: "workspace", durationMs: 15, elapsedMs: 15 },
        { name: "tools", durationMs: 15, elapsedMs: 30 },
      ],
    });
  });

  it.each([
    [9_999, 4_999, false],
    [10_000, 0, true],
    [10, 5_000, true],
  ] as const)("warns for slow summaries (total=%s, stage=%s)", (totalMs, durationMs, warn) => {
    const log = { isEnabled: () => false, warn: vi.fn(), trace: vi.fn() };
    logEmbeddedRunStageSummary(
      { totalMs, stages: [{ name: "auth", durationMs, elapsedMs: durationMs }] },
      log,
      () => "startup",
    );
    expect(log.warn).toHaveBeenCalledTimes(warn ? 1 : 0);
    expect(log.trace).not.toHaveBeenCalled();
  });

  it("supports custom warning thresholds", () => {
    const log = { isEnabled: () => false, warn: vi.fn(), trace: vi.fn() };
    logEmbeddedRunStageSummary(
      { totalMs: 2_000, stages: [{ name: "auth", durationMs: 10, elapsedMs: 10 }] },
      log,
      () => "startup",
      { totalThresholdMs: 2_000, stageThresholdMs: 1_000 },
    );
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("keeps orchestration startup stages ordered and cumulative", () => {
    let clock = 0;
    const tracker = createStageTimingTracker(() => clock);

    clock = 2;
    tracker.mark("workspace");
    clock = 7;
    tracker.mark("harness-selection");
    clock = 18;
    tracker.mark("prepared-runtime");
    clock = 21;
    tracker.mark("runtime-context");
    tracker.mark("runtime-plugins");

    expect(formatEmbeddedRunStageSummary("startup", tracker.snapshot())).toBe(
      `startup pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=21 stages=workspace:2ms@2ms,harness-selection:5ms@7ms,prepared-runtime:11ms@18ms,runtime-context:3ms@21ms,runtime-plugins:0ms@21ms`,
    );
  });

  it("names first-attempt dispatch subspans for slow startup summaries", () => {
    // First-attempt dispatch stages use stable names because logs are compared
    // across provider/runtime startup regressions.
    let clock = 0;
    const tracker = createStageTimingTracker(() => clock);

    clock = 10;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.workspace);
    clock = 40;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.prompt);
    clock = 90;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan);
    clock = 91;
    tracker.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);

    expect(formatEmbeddedRunStageSummary("startup", tracker.snapshot())).toBe(
      `startup pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=91 stages=attempt-workspace:10ms@10ms,attempt-prompt:30ms@40ms,attempt-runtime-plan:50ms@90ms,attempt-dispatch:1ms@91ms`,
    );
  });
});
