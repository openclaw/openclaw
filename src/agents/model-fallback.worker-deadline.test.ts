import { afterEach, expect, it, vi } from "vitest";
import { buildKnownAgentRunFailureReplyPayload } from "../auto-reply/reply/agent-runner-failure-reply.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveModelFallbackError } from "./failover-error.js";
import { findLocalWorkerTaskFailure } from "./failover/local-preparation-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

const workerUrl = resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker);
const pools: WorkerTaskPool<unknown, { label: string }>[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.useRealTimers();
});

// Warm the worker, then await its IPC notification before advancing the deadline.
// The caller must assert view[0] outside fallback, which could swallow a failed assertion.
async function runPoolTaskWithDeadline(
  pool: WorkerTaskPool<unknown, { label: string }>,
): Promise<{ deadline: Error & { code?: string }; view: Int32Array }> {
  await pool.run({ label: "warm" }, {});
  const counters = new SharedArrayBuffer(8);
  const view = new Int32Array(counters);
  const started = createDeferredCore();
  const pending = pool.run(
    () => ({ label: "hang-until-deadline", wait: true, counters, notifications: 1 }),
    { timeoutMs: 50, onNotification: () => started.resolve() },
  );
  // Handle the expected rejection before advancing timers yields to the event loop.
  const deadline = pending.catch((value: unknown) => value);
  await started.promise;
  try {
    await vi.advanceTimersByTimeAsync(50);
    return { deadline: (await deadline) as Error & { code?: string }, view };
  } finally {
    // Release the blocked worker for pool cleanup after cancellation.
    Atomics.store(view, 1, 1);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

const fallbackOptions = {
  cfg: undefined,
  provider: "fixture-primary",
  model: "fixture-model",
  manifestPlugins: [],
  fallbacksOverride: ["fixture-next/fixture-model"],
  sessionId: "worker-deadline-session",
  lane: "worker-deadline-lane",
};

it("stops configured fallback when a real pool deadline fires during preparation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pool = new WorkerTaskPool<unknown, { label: string }>({ workerUrl, maxWorkers: 1 });
  pools.push(pool);
  let dispatched: Int32Array | undefined;
  let deadline: (Error & { code?: string }) | undefined;
  try {
    const run = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      if (run.mock.calls.length === 1) {
        const outcome = await runPoolTaskWithDeadline(pool);
        dispatched = outcome.view;
        deadline = outcome.deadline;
        throw outcome.deadline;
      }
      return "fallback candidate ran";
    });
    const attempt = runWithModelFallback({ ...fallbackOptions, run });
    // Handle rejection before yielding to the candidate and its controlled deadline.
    const resultPromise = attempt.then(
      (value) => ({ ok: true as const, value }),
      (value: unknown) => ({ ok: false as const, value }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(dispatched?.[0]).toBeGreaterThan(0);
    expect(deadline).toBeDefined();
    expect(findLocalWorkerTaskFailure(deadline)).toBe(deadline);
    expect(resolveModelFallbackError(deadline)).toEqual({
      kind: "coordination",
      error: deadline,
    });
    expect(result).toEqual({ ok: false, value: deadline });
    expect(run).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("still rotates models for a genuine provider HTTP 408 timeout", async () => {
  const provider408 = Object.assign(new Error("request timed out"), { status: 408 });
  expect(resolveModelFallbackError(provider408)).toMatchObject({
    kind: "failover",
    error: { reason: "timeout", status: 408 },
  });

  const run = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(provider408)
    .mockResolvedValueOnce("fallback candidate ran");
  const result = await runWithModelFallback({ ...fallbackOptions, run });
  expect(result.outcome).toBe("completed");
  expect(run).toHaveBeenCalledTimes(2);
});

it("keeps real pool overload local through fallback and the normal failure reply", async () => {
  const pool = new WorkerTaskPool<unknown, { label: string }>({
    workerUrl,
    maxWorkers: 1,
    maxPendingTasks: 1,
    sharedCompute: false,
  });
  pools.push(pool);
  const heldInput = Promise.withResolvers<{ label: string }>();
  const held = pool.run(() => heldInput.promise, {});
  const heldOutcome = held.catch(() => undefined);
  let overload: unknown;
  const run = vi.fn(async () => {
    if (run.mock.calls.length > 1) {
      return "unexpected provider fallback";
    }
    try {
      await pool.run({ label: "over-capacity" }, {});
    } catch (error) {
      overload = error;
      throw error;
    }
    return "unexpected admission";
  });
  try {
    const outcome = await runWithModelFallback({ ...fallbackOptions, run }).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );
    expect(overload).toBeInstanceOf(WorkerTaskError);
    expect(overload).toMatchObject({ code: "overloaded", message: "worker task capacity reached" });
    expect(outcome).toEqual({ ok: false, error: overload });
    expect(run).toHaveBeenCalledOnce();
    expect(
      buildKnownAgentRunFailureReplyPayload({
        err: overload,
        sessionCtx: { Provider: "discord", Surface: "discord", ChatType: "group" },
        resolvedVerboseLevel: "off",
      }),
    ).toMatchObject({
      text: "OpenClaw's local workers are at capacity. Check the conversation for completed work before trying again.",
      isError: true,
    });
  } finally {
    heldInput.resolve({ label: "released" });
    await heldOutcome;
  }
});

it("still rotates models for genuine provider HTTP 503 overload", async () => {
  const error = Object.assign(new Error("provider overloaded"), { status: 503 });
  const run = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce("recovered");
  expect(await runWithModelFallback({ ...fallbackOptions, run })).toMatchObject({
    outcome: "completed",
    result: "recovered",
  });
  expect(run).toHaveBeenCalledTimes(2);
});
