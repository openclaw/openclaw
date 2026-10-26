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
    expect(mocks.warn).toHaveBeenCalled();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it.each<[string, string | undefined, number | undefined]>([
  ["1250", undefined, undefined],
  ["0x10", undefined, 2_000],
  ["10ms", "1", 250],
])("disposes after settlement or timeout: %s", async (override, fast, timeoutMs) => {
  vi.stubEnv("OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS", override);
  vi.stubEnv("OPENCLAW_TEST_FAST", fast);
  const order: string[] = [];
  const settle = createDeferred();
  const cleanupPromise = (await loadCleanup()).cleanupEmbeddedAttemptResources({
    ...runIdentity,
    aborted: true,
    abortSettlePromise: settle.promise,
    flushPendingToolResultsAfterIdle: async () => {
      order.push("flush");
      if (timeoutMs === undefined) {
        throw new Error("flush failed");
      }
    },
    session: {
      dispose: () => {
        order.push("dispose");
      },
    },
    sessionManager: undefined,
    removeToolResultContextGuard: () => {
      order.push("guard");
    },
  });
  await vi.advanceTimersByTimeAsync(timeoutMs === undefined ? 0 : timeoutMs - 1);
  expect(order).toEqual(["guard"]);
  expect(mocks.warn).not.toHaveBeenCalled();
  if (timeoutMs === undefined) {
    settle.resolve();
  } else {
    await vi.advanceTimersByTimeAsync(1);
  }
  await cleanupPromise;
  expect(order).toEqual(["guard", "flush", "dispose"]);
  if (timeoutMs !== undefined) {
    expect(mocks.warn).toHaveBeenCalled();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels an idle wait without detaching runtime disposal", async () => {
  const { flushPendingToolResultsAfterIdle } = await import("../wait-for-idle-before-flush.js");
  const controller = new AbortController();
  const idle = createDeferred();
  const runtime = createDeferred();
  const dispose = vi.fn();
  const disposeRuntime = vi.fn(async () => await runtime.promise);
  const settled = vi.fn();
  const cleanupPromise = (await loadCleanup())
    .cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle,
      session: { agent: { waitForIdle: () => idle.promise }, dispose },
      sessionManager: undefined,
      abortSignal: controller.signal,
      bundleMcpRuntime: { dispose: disposeRuntime },
    })
    .then(settled);
  try {
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(disposeRuntime).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    runtime.resolve();
    await cleanupPromise;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    idle.resolve();
    runtime.resolve();
    await cleanupPromise;
  }
});
