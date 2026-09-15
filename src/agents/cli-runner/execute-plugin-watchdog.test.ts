import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CliBackendExecuteContext } from "../../plugins/cli-backend.types.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

function waitUntilAborted(execution: CliBackendExecuteContext): Promise<void> {
  const signal = execution.abortSignal;
  if (!signal) {
    throw new Error("Host execution did not expose its abort signal.");
  }
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("CLI test run was aborted."),
        ),
      { once: true },
    );
  });
}

afterEach(() => {
  closePluginTestAdmissions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("plugin-owned CLI watchdog host-suspend accounting", () => {
  it("credits detected host-suspend time instead of counting it as CLI silence", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 500_000 });
    const errors: unknown[] = [];
    const streamStarted = createDeferred();
    const run = runPlugin(
      context,
      async function* (execution) {
        streamStarted.resolve();
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      {
        noOutputTimeoutMs: 100_000,
        onNoOutputTimeout: (error) => errors.push(error),
      },
    );
    await streamStarted.promise;

    // Active silence well within the 100s budget: no abort.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errors).toHaveLength(0);

    // The host suspends for 120s: the clock jumps while no timer can run,
    // like a laptop lid close. The next watchdog tick credits the frozen span.
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toHaveLength(0);

    // Only the remaining active budget (~70s) can still abort the run, and
    // the reported silence stays accurate (~100s, not ~220s of wall time).
    await vi.advanceTimersByTimeAsync(70_000);
    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toContain("no output for 100s");
  });

  it("counts sub-threshold timer delays against the no-output budget", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 500_000 });
    const streamStarted = createDeferred();
    const run = runPlugin(
      context,
      async function* (execution) {
        streamStarted.resolve();
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 100_000 },
    );
    await streamStarted.promise;

    // A 30s event-loop stall stays below the 45s host-suspend threshold, so
    // it must not be credited back and the run still aborts on the budget.
    vi.setSystemTime(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(75_000);

    await expect(run).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
  });

  it("does not drain the overall run deadline during a detected host suspend", async () => {
    vi.useFakeTimers();
    const { context } = await createExecution({ timeoutMs: 100_000 });
    const streamStarted = createDeferred();
    let completed = false;
    const run = runPlugin(
      context,
      async function* (execution) {
        streamStarted.resolve();
        await waitUntilAborted(execution);
        yield SUCCESS_RESULT;
      },
      { noOutputTimeoutMs: 500_000 },
    ).then((result) => {
      completed = true;
      return result;
    });
    await streamStarted.promise;

    await vi.advanceTimersByTimeAsync(20_000);
    expect(completed).toBe(false);

    // Suspend beyond the threshold: the frozen span must not drain the 100s
    // overall budget (only ~20s of it has actively elapsed so far).
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(82_000);
    await expect(run).resolves.toMatchObject({
      reason: "overall-timeout",
      timedOut: true,
      noOutputTimedOut: false,
    });
  });
});
