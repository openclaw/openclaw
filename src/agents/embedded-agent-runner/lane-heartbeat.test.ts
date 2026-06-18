// Focused tests for the lane-task progress heartbeat helper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLaneTaskProgressHeartbeat, withLaneTaskProgressHeartbeat } from "./lane-heartbeat.js";

describe("startLaneTaskProgressHeartbeat", () => {
  it("calls noteProgress at the requested interval", () => {
    vi.useFakeTimers();
    const noteProgress = vi.fn();
    const handle = startLaneTaskProgressHeartbeat(noteProgress, 1_000);
    expect(noteProgress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(noteProgress).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(noteProgress).toHaveBeenCalledTimes(3);
    handle.stop();
    vi.useRealTimers();
  });

  it("stops calling noteProgress after stop()", () => {
    vi.useFakeTimers();
    const noteProgress = vi.fn();
    const handle = startLaneTaskProgressHeartbeat(noteProgress, 1_000);
    vi.advanceTimersByTime(1_000);
    expect(noteProgress).toHaveBeenCalledTimes(1);
    handle.stop();
    vi.advanceTimersByTime(5_000);
    expect(noteProgress).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stop() is idempotent", () => {
    vi.useFakeTimers();
    const noteProgress = vi.fn();
    const handle = startLaneTaskProgressHeartbeat(noteProgress, 1_000);
    handle.stop();
    handle.stop();
    vi.advanceTimersByTime(5_000);
    expect(noteProgress).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("uses a 20s default interval", () => {
    vi.useFakeTimers();
    const noteProgress = vi.fn();
    const handle = startLaneTaskProgressHeartbeat(noteProgress);
    vi.advanceTimersByTime(19_999);
    expect(noteProgress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(noteProgress).toHaveBeenCalledTimes(1);
    handle.stop();
    vi.useRealTimers();
  });
});

describe("withLaneTaskProgressHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the heartbeat when the task resolves", async () => {
    const noteProgress = vi.fn();
    const task = Promise.resolve("done");
    const wrapped = withLaneTaskProgressHeartbeat(noteProgress, task, 1_000);
    // Let the microtask queue drain so the finally block runs.
    await vi.advanceTimersByTimeAsync(0);
    await expect(wrapped).resolves.toBe("done");
    expect(noteProgress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(noteProgress).not.toHaveBeenCalled();
  });

  it("stops the heartbeat when the task rejects", async () => {
    const noteProgress = vi.fn();
    const failure = new Error("boom");
    let rejectTask!: (err: Error) => void;
    const task = new Promise<string>((_resolve, reject) => {
      rejectTask = reject;
    });
    const wrapped = withLaneTaskProgressHeartbeat(noteProgress, task, 1_000);
    rejectTask(failure);
    await expect(wrapped).rejects.toBe(failure);
    vi.advanceTimersByTime(5_000);
    expect(noteProgress).not.toHaveBeenCalled();
  });

  it("keeps ticking noteProgress until the task settles", async () => {
    const noteProgress = vi.fn();
    let resolveTask!: (value: string) => void;
    const task = new Promise<string>((resolve) => {
      resolveTask = resolve;
    });
    const wrapped = withLaneTaskProgressHeartbeat(noteProgress, task, 1_000);
    vi.advanceTimersByTime(2_500);
    expect(noteProgress).toHaveBeenCalledTimes(2);
    resolveTask("done");
    await expect(wrapped).resolves.toBe("done");
    vi.advanceTimersByTime(5_000);
    expect(noteProgress).toHaveBeenCalledTimes(2);
  });
});
