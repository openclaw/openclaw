import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CodeModeHeadlessAbortError, CodeModeHeadlessTimeoutError } from "./code-mode-errors.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import { runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";

describe("headless Code Mode cancellation", () => {
  afterEach(async () => {
    try {
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      vi.useRealTimers();
      await resetCodeModeTestState();
    }
  });

  it("classifies a wall-clock expiry observed during a real tool leg as timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const wallClockMs = 15_000;
    const toolStarted = createDeferred();
    const slowLeg = pluginToolWithExecute("slow_leg", "Never settles on its own", async () => {
      toolStarted.resolve();
      return await new Promise<never>(() => {});
    });

    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness([slowLeg]),
      code: "await slow_leg({}); return true;",
      wallClockMs,
    });
    await toolStarted.promise;
    await vi.advanceTimersByTimeAsync(wallClockMs);
    const result = await resultPromise;

    expect(result, JSON.stringify(result)).toMatchObject({
      status: "failed",
      code: "timeout",
      toolCallCount: 1,
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
    const config = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId);
    const controller = new AbortController();
    const resultPromise = testing.runCodeModeExecutor(
      {
        kind: "exec",
        source: "while (true) {}",
        config,
        catalog: [],
        apiFiles: [],
        namespaces: [],
      },
      { timeoutMs: 5000, executor: config.executor, signal: controller.signal },
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
      const config = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId);
      // The scope observes its own deadline inside the host exchange, so the run
      // can reject before the abort controller that shares that deadline settles.
      const scopeSignal = new AbortController().signal;

      const result = await testing.runCodeModeExecutor(
        {
          kind: "exec",
          source: "await new Promise((resolve) => setTimeout(resolve, 0)); return 1;",
          config,
          catalog: [],
          apiFiles: [],
          namespaces: [],
        },
        {
          timeoutMs: config.timeoutMs + 2000,
          executor: config.executor,
          signal: scopeSignal,
          inlineHost: {
            onBoundary: async () => {
              throw createError();
            },
          },
        },
      );

      expect(scopeSignal.aborted).toBe(false);
      expect(result, JSON.stringify(result)).toMatchObject({ status: "failed", code, error });
    },
  );
});
