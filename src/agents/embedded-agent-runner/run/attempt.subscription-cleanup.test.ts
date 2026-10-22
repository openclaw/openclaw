import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../../../test-utils/prepare-compiled-subprocesses.js";
import { createDeferred } from "../../../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.js", () => ({ log: { warn: mocks.warn } }));
const runIdentity = { runId: "run-1", sessionId: "session-1" };
const yieldIdentity = { ...runIdentity, reason: "sessions_yield" as const };
const loadCleanup = () => import("./attempt-subscription-cleanup.js");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS", "1250");
  vi.stubEnv("OPENCLAW_TEST_FAST", undefined);
  // Timeout policy is captured at module load, once per cleanup owner lifetime.
  vi.resetModules();
  mocks.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each([false, true])("sessions_yield clears timers (reject=%s)", async (reject) => {
  const { waitForEmbeddedAbortSettle } = await loadCleanup();
  await waitForEmbeddedAbortSettle({
    promise: reject ? Promise.reject(new Error("settle failed")) : null,
    ...yieldIdentity,
  });
  if (reject) {
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      "agent cleanup failed: runId=run-1 sessionId=session-1 step=sessions_yield-abort-settle error=settle failed",
    );
  }
  expect(vi.getTimerCount()).toBe(0);
});

function orderedCleanup(order: string[], abortSettlePromise: Promise<unknown>, failFlush = false) {
  return {
    ...runIdentity,
    aborted: true,
    abortSettlePromise,
    flushPendingToolResultsAfterIdle: async () => {
      order.push("flush");
      if (failFlush) {
        throw new Error("flush failed");
      }
    },
    session: {
      agent: { waitForIdle: async () => {} },
      dispose: () => {
        order.push("dispose");
      },
    },
    sessionManager: undefined,
  };
}

it("waits for aborted prompt settlement and disposes even when the subsequent flush fails", async () => {
  const order: string[] = [];
  const settle = createDeferred();

  const cleanupPromise = (await loadCleanup()).cleanupEmbeddedAttemptResources({
    removeToolResultContextGuard: () => {
      order.push("guard");
    },
    ...orderedCleanup(order, settle.promise, true),
  });

  await Promise.resolve();

  expect(order).toEqual(["guard"]);

  settle.resolve();
  await cleanupPromise;

  expect(order).toEqual(["guard", "flush", "dispose"]);
});

it.each([
  { override: "0x10", fast: undefined, timeoutMs: 2_000 },
  { override: "10ms", fast: "1", timeoutMs: 250 },
])(
  "continues cleanup after $timeoutMs ms with override=$override and fast=$fast",
  async ({ override, fast, timeoutMs }) => {
    vi.stubEnv("OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS", override);
    vi.stubEnv("OPENCLAW_TEST_FAST", fast);
    const timeoutCleanup = await loadCleanup();
    const order: string[] = [];

    const cleanupPromise = timeoutCleanup.cleanupEmbeddedAttemptResources(
      orderedCleanup(order, new Promise(() => {})),
    );

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(order).toEqual([]);
    expect(mocks.warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await cleanupPromise;

    expect(order).toEqual(["flush", "dispose"]);
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
      `agent cleanup timed out: runId=run-1 sessionId=session-1 step=embedded-abort-settle timeoutMs=${timeoutMs}`,
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("cancels an idle wait without detaching runtime disposal", async () => {
  const { flushPendingToolResultsAfterIdle } = await import("../wait-for-idle-before-flush.js");
  const controller = new AbortController();
  const idle = createDeferred();
  const runtime = createDeferred();
  const dispose = vi.fn();
  const disposeRuntime = vi.fn(async () => await runtime.promise);
  let settled = false;
  const cleanupPromise = (await loadCleanup())
    .cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle,
      session: { agent: { waitForIdle: () => idle.promise }, dispose },
      sessionManager: undefined,
      abortSignal: controller.signal,
      bundleMcpRuntime: { dispose: disposeRuntime },
    })
    .then(() => {
      settled = true;
    });
  try {
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    runtime.resolve();
    await cleanupPromise;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    idle.resolve();
    runtime.resolve();
    await cleanupPromise;
  }
});
