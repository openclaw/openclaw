import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function createManager() {
  return {
    getSessionTarget: () => undefined,
    hasPendingToolResults: () => true,
    flushPendingToolResults: vi.fn(),
  };
}

it("skips idle waiting for an already canceled run but still flushes pending results", async () => {
  const controller = new AbortController();
  controller.abort();
  const idle = createDeferred();
  const waitForIdle = vi.fn(() => idle.promise);
  const sessionManager = createManager();
  const options = { agent: { waitForIdle }, sessionManager, abortSignal: controller.signal };
  const flushing = flushPendingToolResultsAfterIdle(options);
  await vi.advanceTimersByTimeAsync(0);
  const startedIdleWait = waitForIdle.mock.calls.length;
  idle.resolve();
  await flushing;
  expect(startedIdleWait).toBe(0);
  expect(sessionManager.flushPendingToolResults).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["cancel", "cancel-on-entry", "idle", "timeout", "failure"] as const)(
  "flushes after %s and releases the idle timer and abort listener",
  async (outcome) => {
    const controller = new AbortController();
    const idle = createDeferred();
    const waitForIdle = vi.fn(() => {
      if (outcome === "cancel-on-entry") {
        controller.abort();
      }
      return idle.promise;
    });
    const sessionManager = createManager();
    const options = {
      agent: { waitForIdle },
      sessionManager,
      abortSignal: controller.signal,
      timeoutMs: 100,
    };
    const flushing = flushPendingToolResultsAfterIdle(options);
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(sessionManager.flushPendingToolResults).not.toHaveBeenCalled();
    if (outcome === "cancel") {
      controller.abort();
    } else if (outcome === "idle") {
      idle.resolve();
    } else if (outcome === "failure") {
      idle.reject(new Error("idle failed"));
    } else if (outcome === "timeout") {
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(0);
    const flushed = sessionManager.flushPendingToolResults.mock.calls.length;
    // A provider may reject its old idle promise after cancellation won the wait.
    if (outcome === "cancel" || outcome === "cancel-on-entry") {
      idle.reject(new Error("late idle failure"));
    } else {
      idle.resolve();
    }
    await flushing;
    expect(flushed).toBe(1);
    expect(sessionManager.flushPendingToolResults).toHaveBeenCalledOnce();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
