// Real-boundary regression coverage: a genuine worker-pool deadline is detected
// as local infrastructure (so reply copy stays accurate) while the configured
// fallback chain is preserved — a later candidate rebuilds its own context and
// can recover from an intermittent worker deadline. A genuine provider HTTP
// timeout also keeps rotating. Only the deadline timers are faked; the worker
// spawn and IPC stay real, and the check never depends on CI scheduling.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { hasLocalWorkerTaskTimeout, resolveModelFallbackError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback-runner.js";

const workerUrl = resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker);
const pools: WorkerTaskPool<unknown, { label: string }>[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.useRealTimers();
});

/**
 * Dispatches a real task to a pool worker and lets the host deadline abort it:
 * the input factory resolves immediately (so the task is posted to the worker
 * over IPC), then the worker blocks on Atomics.wait, so the pool's own deadline
 * timer (worker-task-pool-core.ts:525) aborts the dispatched task with the
 * production WorkerTaskError("worker task timed out", "timeout").
 *
 * The pool is warmed with a settled task first so worker boot has already
 * finished; otherwise the worker's first dispatch can lag the fake deadline on
 * a loaded host and the check would abort a queued, not dispatched, task.
 *
 * The caller must assert the returned view proves the worker started the task
 * (view[0] > 0) outside the fallback owner, which would otherwise swallow a
 * failing dispatch proof as an ordinary candidate error.
 */
async function runPoolTaskWithDeadline(
  pool: WorkerTaskPool<unknown, { label: string }>,
): Promise<{ deadline: Error & { code?: string }; view: Int32Array }> {
  await pool.run({ label: "warm" }, {});
  const counters = new SharedArrayBuffer(8);
  const view = new Int32Array(counters);
  const release = () => Atomics.store(view, 1, 1);
  const pending = pool.run(() => ({ label: "hang-until-deadline", wait: true, counters }), {
    timeoutMs: 50,
  });
  // The worker increments counters[0] as soon as it starts the dispatched task.
  // Yield to the real event loop (setImmediate is not faked) until it does, so
  // the deadline fires on a genuinely dispatched task that reached a worker over
  // IPC, not on host-side preparation.
  for (let i = 0; i < 20_000 && view[0] === 0; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  try {
    await vi.advanceTimersByTimeAsync(50);
    return {
      deadline: (await pending.catch((value: unknown) => value)) as Error & { code?: string },
      view,
    };
  } finally {
    // Wake the blocked worker so pool close can retire it cleanly after the
    // deadline has already cancelled the task.
    release();
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

describe("model fallback with a real local worker deadline", () => {
  it("preserves configured fallback when a real pool deadline fires during the turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = new WorkerTaskPool<unknown, { label: string }>({ workerUrl, maxWorkers: 1 });
    pools.push(pool);
    let dispatched: Int32Array | undefined;
    let deadline: (Error & { code?: string }) | undefined;
    try {
      // The first candidate performs context-worker work during the turn; that
      // work hangs and the host deadline aborts it while the fallback owner is
      // awaiting this attempt. The deadline is still detected as local, but the
      // configured chain must advance so a later candidate can recover.
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
      // Attach the handler before awaiting so the rejection the deadline
      // triggers is always handled, then let the owner reach the candidate
      // attempt (microtask-only path when cfg is unset). The deadline fires
      // inside runPoolTaskWithDeadline after the task is genuinely dispatched.
      const resultPromise = attempt.then(
        (value) => ({ ok: true as const, value }),
        (value: unknown) => ({ ok: false as const, value }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const result = await resultPromise;
      // Assert every proof outside the fallback owner, so a swallowed candidate
      // assertion cannot fake the real-dispatch or attribution claims.
      expect(dispatched?.[0]).toBeGreaterThan(0);
      expect(deadline).toBeDefined();
      expect(hasLocalWorkerTaskTimeout(deadline!)).toBe(true);
      const resolution = resolveModelFallbackError(deadline!);
      expect(resolution.kind).toBe("failover");
      if (resolution.kind === "failover") {
        expect(resolution.error.status).toBeUndefined();
      }
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe("completed");
      }
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rotates models for a genuine provider HTTP 408 timeout", async () => {
    const provider408 = Object.assign(new Error("request timed out"), { status: 408 });
    const resolution = resolveModelFallbackError(provider408);
    expect(resolution.kind).toBe("failover");
    if (resolution.kind === "failover") {
      expect(resolution.error.reason).toBe("timeout");
      expect(resolution.error.status).toBe(408);
    }

    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(provider408)
      .mockResolvedValueOnce("fallback candidate ran");
    const result = await runWithModelFallback({ ...fallbackOptions, run });
    expect(result.outcome).toBe("completed");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
