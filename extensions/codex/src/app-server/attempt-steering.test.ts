// Codex tests cover attempt steering plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexSteeringQueue } from "./attempt-steering.js";

describe("Codex app-server steering queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves queued steering only after Codex reports consuming it", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("accepted", { debounceMs: 0 });
    let settled = false;
    void queued.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(queue.confirmConsumed(["initial prompt"])).toBe(false);
    expect(settled).toBe(false);
    expect(queue.confirmConsumed(["accepted"])).toBe(true);
    await queued;

    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "accepted", text_elements: [] }],
    });
  });

  it("rejects queued steering when turn/steer is rejected", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer a compact turn");
    });
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("rejected", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("cannot steer a compact turn");
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "rejected", text_elements: [] }],
    });
  });

  it("resolves when Codex reports consumption before turn/steer is acknowledged", async () => {
    let acceptSteer: (() => void) | undefined;
    const steerAccepted = new Promise<void>((resolve) => {
      acceptSteer = resolve;
    });
    const request = vi.fn(async () => {
      await steerAccepted;
      return { turnId: "turn-1" };
    });
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("consumed first", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(queue.confirmConsumed(["consumed first"])).toBe(true);
    await queued;

    acceptSteer?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("batches queued steering after a nonzero debounce while the turn is active", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const firstQueued = queue.queue("first", { debounceMs: 5 });
    const secondQueued = queue.queue("second", { debounceMs: 5 });

    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(queue.confirmConsumed(["first", "second"])).toBe(true);
    await Promise.all([firstQueued, secondQueued]);

    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "first", text_elements: [] },
        { type: "text", text: "second", text_elements: [] },
      ],
    });
  });

  it("rejects queued steering when the run aborts before debounce flush", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: controller.signal,
    });

    const queued = queue.queue("aborted", { debounceMs: 1 });
    const rejected = expect(queued).rejects.toThrow("codex app-server steering queue aborted");
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(request).not.toHaveBeenCalled();
  });

  it("answers pending user input without sending turn/steer", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const answerPendingUserInput = vi.fn(() => true);
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput,
      signal: new AbortController().signal,
    });

    await queue.queue("answer locally", { debounceMs: 0 });

    expect(answerPendingUserInput).toHaveBeenCalledWith("answer locally");
    expect(request).not.toHaveBeenCalled();
  });

  it("answers pending user input before applying the steering availability fence", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const answerPendingUserInput = vi.fn(() => true);
    const rejectSteering = vi.fn(() => new Error("turn release pending"));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput,
      rejectSteering,
      signal: new AbortController().signal,
    });

    await queue.queue("prompt answer", { debounceMs: 0 });

    expect(answerPendingUserInput).toHaveBeenCalledWith("prompt answer");
    expect(rejectSteering).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects ordinary steering when the turn is unavailable", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      rejectSteering: () => new Error("turn release pending"),
      signal: new AbortController().signal,
    });

    await expect(queue.queue("completion wake", { debounceMs: 0 })).rejects.toThrow(
      "turn release pending",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("holds steering while paused and resumes both delivered and buffered text", async () => {
    let acceptFirstSteer: (() => void) | undefined;
    const firstSteerAccepted = new Promise<void>((resolve) => {
      acceptFirstSteer = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstSteerAccepted;
        return { turnId: "turn-1" };
      })
      .mockResolvedValue({ turnId: "turn-1" });
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const inFlight = queue.queue("already dispatched", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    queue.pause();
    acceptFirstSteer?.();
    await vi.advanceTimersByTimeAsync(0);

    const buffered = queue.queue("arrived while paused", { debounceMs: 0 });
    expect(request).toHaveBeenCalledTimes(1);

    queue.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.confirmConsumed(["already dispatched"])).toBe(true);
    expect(queue.confirmConsumed(["arrived while paused"])).toBe(true);
    await Promise.all([inFlight, buffered]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "arrived while paused", text_elements: [] }],
    });
  });

  it("rejects an in-flight logical delivery when the queue is cancelled", async () => {
    let acceptSteer: (() => void) | undefined;
    const steerAccepted = new Promise<void>((resolve) => {
      acceptSteer = resolve;
    });
    const request = vi.fn(async () => {
      await steerAccepted;
      return { turnId: "turn-1" };
    });
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("accepted too late", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    queue.cancel();
    acceptSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });

  it("rejects an acknowledged but unconsumed steer when the queue is cancelled", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("accepted but not consumed", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    queue.cancel();
    await expect(queued).rejects.toThrow("steering queue cancelled");
  });

  it("does not dispatch a chained batch after it is paused and cancelled", async () => {
    let acceptFirstSteer: (() => void) | undefined;
    const firstSteerAccepted = new Promise<void>((resolve) => {
      acceptFirstSteer = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstSteerAccepted;
        return { turnId: "turn-1" };
      })
      .mockResolvedValue({ turnId: "turn-1" });
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal: new AbortController().signal,
    });

    const first = queue.queue("already on the wire", { debounceMs: 0 });
    const firstRejected = expect(first).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);
    const second = queue.queue("waiting in the send chain", { debounceMs: 0 });
    const secondRejected = expect(second).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);

    queue.pause();
    queue.cancel();
    acceptFirstSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([firstRejected, secondRejected]);

    expect(request).toHaveBeenCalledTimes(1);
  });
});
