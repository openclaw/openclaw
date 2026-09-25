// Matrix tests cover monitor task runner idle deadlines.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatrixMonitorTaskRunner, getMatrixMonitorTaskSignal } from "./task-runner.js";

const IDLE_WINDOW_MS = 30_000;

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => {
      resolve?.();
    },
  };
}

async function idleStatusAfter(
  idle: Promise<void>,
  advanceMs: number,
): Promise<"resolved" | "pending"> {
  let settled = false;
  void idle.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(advanceMs);
  for (let turn = 0; turn < 50; turn += 1) {
    if (settled) {
      return "resolved";
    }
    await Promise.resolve();
  }
  return "pending";
}

describe("createMatrixMonitorTaskRunner waitForIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after one idle window when a task never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runner = createMatrixMonitorTaskRunner({
      logger: createLogger(),
      logVerboseMessage: vi.fn(),
    });
    void runner.runDetachedTask("hung join", () => new Promise<void>(() => {}));
    const idle = runner.waitForIdle();
    await expect(idleStatusAfter(idle, IDLE_WINDOW_MS - 1)).resolves.toBe("pending");
    await expect(idleStatusAfter(idle, 1)).resolves.toBe("resolved");
    await idle;
  });

  it("resets the idle window when a task settles before the deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runner = createMatrixMonitorTaskRunner({
      logger: createLogger(),
      logVerboseMessage: vi.fn(),
    });
    const firstGate = createDeferred();
    const first = runner.runDetachedTask("settling join", () => firstGate.promise);
    void runner.runDetachedTask("hung join", () => new Promise<void>(() => {}));
    const idle = runner.waitForIdle();

    await expect(idleStatusAfter(idle, IDLE_WINDOW_MS - 1)).resolves.toBe("pending");
    firstGate.resolve();
    await first;
    await expect(idleStatusAfter(idle, 0)).resolves.toBe("pending");
    // The reset window starts 1ms before the first deadline, so that boundary stays open.
    await expect(idleStatusAfter(idle, 1)).resolves.toBe("pending");
    await expect(idleStatusAfter(idle, IDLE_WINDOW_MS - 2)).resolves.toBe("pending");
    await expect(idleStatusAfter(idle, 1)).resolves.toBe("resolved");
    await idle;
  });

  it("aborts in-flight task signals when the idle window expires without close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const logger = createLogger();
    const logVerboseMessage = vi.fn();
    const runner = createMatrixMonitorTaskRunner({ logger, logVerboseMessage });
    const started = createDeferred();
    let abortedAtStart = true;
    let observedAborted: boolean | undefined;
    const task = runner.runDetachedTask("hung join", async () => {
      abortedAtStart = getMatrixMonitorTaskSignal()?.aborted === true;
      started.resolve();
      await new Promise<void>((resolve) => {
        const signal = getMatrixMonitorTaskSignal();
        if (!signal || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      observedAborted = getMatrixMonitorTaskSignal()?.aborted === true;
    });

    await started.promise;
    expect(abortedAtStart).toBe(false);

    const idle = runner.waitForIdle();
    await expect(idleStatusAfter(idle, IDLE_WINDOW_MS)).resolves.toBe("resolved");
    await idle;
    await task;
    expect(observedAborted).toBe(true);
    expect(logVerboseMessage).toHaveBeenCalledWith(expect.stringContaining("waitForIdle"));
    const verbose = logVerboseMessage.mock.calls.map((call) => String(call[0])).join("\n");
    expect(verbose).toContain(String(IDLE_WINDOW_MS));
    expect(verbose).toContain("1");
    expect(logger.warn).toHaveBeenCalledWith("matrix waitForIdle timed out", {
      idleTimeoutMs: IDLE_WINDOW_MS,
      remaining: 1,
    });
  });

  it("close rejects new detached work and aborts an in-flight task signal", async () => {
    const runner = createMatrixMonitorTaskRunner({
      logger: createLogger(),
      logVerboseMessage: vi.fn(),
    });
    const started = createDeferred();
    let observedAborted: boolean | undefined;
    const task = runner.runDetachedTask("in flight", async () => {
      started.resolve();
      await new Promise<void>((resolve) => {
        const signal = getMatrixMonitorTaskSignal();
        if (!signal || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      observedAborted = getMatrixMonitorTaskSignal()?.aborted === true;
    });

    await started.promise;
    runner.close();
    await task;
    expect(observedAborted).toBe(true);

    let ran = false;
    await runner.runDetachedTask("after close", async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  it("returns without a timeout warning when a task settles inside the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const logger = createLogger();
    const logVerboseMessage = vi.fn();
    const runner = createMatrixMonitorTaskRunner({ logger, logVerboseMessage });
    const gate = createDeferred();
    const task = runner.runDetachedTask("quick join", async () => {
      await gate.promise;
    });
    const idle = runner.waitForIdle();
    gate.resolve();
    await task;
    await expect(idleStatusAfter(idle, 0)).resolves.toBe("resolved");
    await idle;
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logVerboseMessage).not.toHaveBeenCalled();
  });
});
