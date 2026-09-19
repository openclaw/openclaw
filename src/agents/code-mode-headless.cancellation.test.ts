import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CodeModeHeadlessAbortError, CodeModeHeadlessTimeoutError } from "./code-mode-worker.js";
import { runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult } from "./tools/common.js";

describe("headless Code Mode cancellation", () => {
  afterEach(() => {
    try {
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      vi.useRealTimers();
      resetCodeModeTestState();
    }
  });

  it("classifies a wall-clock expiry observed during a real tool leg as timeout", async () => {
    // Only the timer clock is virtual here: the production headless entry, its deadline
    // scope, a real worker and real tools all run unchanged. The first leg parks the run
    // for a known span of real time, and the scope measures its remaining budget with an
    // unfaked performance clock, so the second leg's deadline observation is always armed
    // at least that far ahead of the scope's abort timer - the ordering the classification
    // lost - no matter how fast this run starts.
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const wallClockMs = 15_000;
    const separationMs = 200;
    const toolStarted = createDeferred();
    const warmUp = pluginToolWithExecute("warm_up", "Parks for a fixed real span", async () => {
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, separationMs);
      });
      return jsonResult({ ok: true });
    });
    const slowLeg = pluginToolWithExecute("slow_leg", "Never settles on its own", async () => {
      toolStarted.resolve();
      return await new Promise<never>(() => {});
    });
    const startedAt = performance.now();

    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness([warmUp, slowLeg]),
      code: "await warm_up({}); await slow_leg({}); return true;",
      wallClockMs,
    });
    await toolStarted.promise;
    // Assert the separation before advancing: the second leg's deadline is armed no later
    // than wallClockMs - separationMs, which this advance reaches while the abort timer at
    // wallClockMs stays pending.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(separationMs);

    await vi.advanceTimersByTimeAsync(wallClockMs - separationMs / 2);
    const result = await resultPromise;

    expect(result, JSON.stringify(result)).toMatchObject({
      status: "failed",
      code: "timeout",
      toolCallCount: 2,
    });
  });

  it("completes after canceling a guest timer across two resumes", async () => {
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: `
        const timer = setTimeout(() => {}, 60_000);
        await new Promise((resolve) => setTimeout(resolve, 1));
        clearTimeout(timer);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return "done";
      `,
      wallClockMs: 5_000,
    });

    expect(result).toEqual({
      status: "completed",
      value: "done",
      output: [],
      toolCallCount: 0,
    });
  });

  it("terminates an in-flight worker leg when aborted", async () => {
    const ctx = createHeadlessCodeModeHarness();
    const config = testing.resolveCodeModeHeadlessConfig(ctx);
    const controller = new AbortController();
    const resultPromise = testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "while (true) {}",
        config,
        catalog: [],
        apiFiles: [],
        namespaces: [],
      },
      5000,
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);

    await expect(resultPromise).resolves.toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
  });

  it("classifies caller aborts before the worker leg as aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: "return true;",
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
  });

  it.each([
    {
      name: "deadline",
      createError: () => new CodeModeHeadlessTimeoutError(),
      code: "timeout",
      error: "code mode timeout exceeded",
    },
    {
      name: "abort",
      createError: () => new CodeModeHeadlessAbortError(),
      code: "aborted",
      error: "code mode execution aborted",
    },
  ])(
    "classifies a host exchange that rejects with the scope $name error before its signal settles",
    async ({ createError, code, error }) => {
      const ctx = createHeadlessCodeModeHarness();
      const config = testing.resolveCodeModeHeadlessConfig(ctx);
      // The scope observes its own deadline inside the host exchange, so the run
      // can reject before the abort controller that shares that deadline settles.
      const scopeSignal = new AbortController().signal;

      const result = await testing.runCodeModeWorker(
        {
          kind: "exec",
          source: "await new Promise((resolve) => setTimeout(resolve, 0)); return 1;",
          config,
          catalog: [],
          apiFiles: [],
          namespaces: [],
        },
        config.timeoutMs + 2000,
        undefined,
        scopeSignal,
        {
          onBoundary: async () => {
            throw createError();
          },
        },
      );

      expect(scopeSignal.aborted).toBe(false);
      expect(result, JSON.stringify(result)).toMatchObject({ status: "failed", code, error });
    },
  );
});
