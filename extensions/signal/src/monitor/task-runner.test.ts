// Signal tests cover monitor task-runner idle drain behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignalMonitorTaskRunner, waitForSignalMonitorTeardown } from "./task-runner.js";

function deferredTask() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred task resolver to be initialized");
  }
  return { promise, resolve };
}

const WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

function createHarness() {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } satisfies RuntimeEnv;
  const runner = createSignalMonitorTaskRunner(runtime);
  return { runtime, runner };
}

describe("createSignalMonitorTaskRunner waitForIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when no tasks are in flight", async () => {
    const { runtime, runner } = createHarness();

    await expect(runner.waitForIdle()).resolves.toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("returns when no in-flight task settles within the idle window", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();
    void runner.runTask(() => new Promise(() => {}));

    let resolved = false;
    const idle = runner.waitForIdle().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);
    expect(resolved).toBe(true);
    await expect(idle).resolves.toBeUndefined();

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`${WAIT_FOR_IDLE_TIMEOUT_MS}ms`),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("1 task"));
  });

  it("waits for a task that settles before the idle timeout", async () => {
    const { runtime, runner } = createHarness();
    const pending = deferredTask();
    let settled = false;
    void runner.runTask(async () => {
      await pending.promise;
      settled = true;
    });

    const idle = runner.waitForIdle();
    expect(settled).toBe(false);
    pending.resolve();
    await expect(idle).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("resets the idle timer when a task settles and another is added", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();
    const first = deferredTask();
    const second = deferredTask();
    void runner.runTask(() => first.promise);

    const idle = runner.waitForIdle();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 5_000);
    first.resolve();
    void runner.runTask(() => second.promise);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 5_000);
    expect(runtime.error).not.toHaveBeenCalled();

    second.resolve();
    await expect(idle).resolves.toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
  });
});

describe("waitForSignalMonitorTeardown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns when ingress stop never settles", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();

    let resolved = false;
    const teardown = waitForSignalMonitorTeardown({
      runtime,
      stopIngress: () => new Promise(() => {}),
      stopDaemon: async () => {},
      waitForIdle: (extras) => runner.waitForIdle(extras),
    }).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);
    expect(resolved).toBe(true);
    await expect(teardown).resolves.toBeUndefined();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`${WAIT_FOR_IDLE_TIMEOUT_MS}ms`),
    );
  });

  it("does not return while daemon stop is still unresolved", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();
    const daemon = deferredTask();
    let returned = false;
    const teardown = waitForSignalMonitorTeardown({
      runtime,
      stopDaemon: () => daemon.promise,
      waitForIdle: (extras) => runner.waitForIdle(extras),
    }).then(() => {
      returned = true;
    });

    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS);
    await Promise.resolve();
    expect(returned).toBe(false);
    expect(runtime.error).not.toHaveBeenCalled();

    daemon.resolve();
    await expect(teardown).resolves.toBeUndefined();
    expect(returned).toBe(true);
  });

  it("resets the teardown deadline when receive work still makes progress", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();
    const first = deferredTask();
    const second = deferredTask();
    void runner.runTask(() => first.promise);
    void runner.runTask(() => second.promise);

    let returned = false;
    const teardown = waitForSignalMonitorTeardown({
      runtime,
      stopDaemon: async () => {},
      waitForIdle: (extras) => runner.waitForIdle(extras),
    }).then(() => {
      returned = true;
    });

    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 5_000);
    first.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(returned).toBe(false);
    expect(runtime.error).not.toHaveBeenCalled();

    second.resolve();
    await expect(teardown).resolves.toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not stop the daemon until receive-work drain finishes or times out", async () => {
    vi.useFakeTimers();
    const { runtime, runner } = createHarness();
    let daemonStopped = false;
    const teardown = waitForSignalMonitorTeardown({
      runtime,
      stopIngress: () => new Promise(() => {}),
      stopDaemon: async () => {
        daemonStopped = true;
      },
      waitForIdle: (extras) => runner.waitForIdle(extras),
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(WAIT_FOR_IDLE_TIMEOUT_MS - 1);
    expect(daemonStopped).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(teardown).resolves.toBeUndefined();
    expect(daemonStopped).toBe(true);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`${WAIT_FOR_IDLE_TIMEOUT_MS}ms`),
    );
  });
});
