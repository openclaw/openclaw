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

  function createQueue(request: ReturnType<typeof vi.fn>, signal = new AbortController().signal) {
    return createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      answerPendingUserInput: () => false,
      signal,
    });
  }

  it("resolves only after the matching Codex user message completes", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ turnId: "turn-1" }));
    const queue = createQueue(request);

    const queued = queue.queue("accepted", { debounceMs: 0 });
    let settled = false;
    void queued.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    const requestParams = request.mock.calls[0]?.[1] as { clientUserMessageId?: string };
    expect(requestParams.clientUserMessageId).toBe("openclaw:turn-1:steer:1");
    expect(settled).toBe(false);
    expect(queue.confirmConsumed("unrelated-user-message")).toBe(false);
    expect(queue.confirmConsumed(requestParams.clientUserMessageId ?? "")).toBe(true);
    await queued;
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "accepted", text_elements: [] }],
      clientUserMessageId: "openclaw:turn-1:steer:1",
    });
  });

  it("handles user-message completion before the steer response", async () => {
    let acceptSteer: (() => void) | undefined;
    const steerAccepted = new Promise<void>((resolve) => {
      acceptSteer = resolve;
    });
    const request = vi.fn(async () => {
      await steerAccepted;
      return { turnId: "turn-1" };
    });
    const queue = createQueue(request);

    const queued = queue.queue("consumed first", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await queued;

    acceptSteer?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("batches text under one correlated user-message id", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request);

    const first = queue.queue("first", { debounceMs: 5 });
    const second = queue.queue("second", { debounceMs: 5 });
    await vi.advanceTimersByTimeAsync(5);

    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "first", text_elements: [] },
        { type: "text", text: "second", text_elements: [] },
      ],
      clientUserMessageId: "openclaw:turn-1:steer:1",
    });
  });

  it("rejects the batch when Codex rejects turn/steer", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer this turn");
    });
    const queue = createQueue(request);

    const queued = queue.queue("rejected", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("cannot steer this turn");
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });

  it("rejects accepted but unconsumed steering when cancelled", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request);

    const queued = queue.queue("completion wake", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    queue.cancel();
    await rejected;
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
    await expect(queue.queue("too late", { debounceMs: 0 })).rejects.toThrow(
      "steering queue cancelled",
    );
  });

  it("rejects accepted but unconsumed steering when the run aborts", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, controller.signal);

    const queued = queue.queue("completion wake", { debounceMs: 0 });
    const rejected = expect(queued).rejects.toThrow("steering queue aborted");
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    controller.abort();
    await rejected;
    expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
    await expect(queue.queue("too late", { debounceMs: 0 })).rejects.toThrow(
      "steering queue aborted",
    );
  });

  it("does not dispatch a chained batch after cancellation", async () => {
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
    const queue = createQueue(request);

    const first = queue.queue("on the wire", { debounceMs: 0 });
    const firstRejected = expect(first).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);
    const second = queue.queue("waiting", { debounceMs: 0 });
    const secondRejected = expect(second).rejects.toThrow("steering queue cancelled");
    await vi.advanceTimersByTimeAsync(0);

    queue.cancel();
    acceptFirstSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([firstRejected, secondRejected]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("answers pending user input without steering", async () => {
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

  it("rejects before dispatch when the run is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, controller.signal);

    await expect(queue.queue("aborted", { debounceMs: 0 })).rejects.toThrow(
      "steering queue aborted",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a debounced batch when the run aborts before dispatch", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createQueue(request, controller.signal);

    const queued = queue.queue("aborted", { debounceMs: 5 });
    const rejected = expect(queued).rejects.toThrow("steering queue aborted");
    controller.abort();
    await vi.advanceTimersByTimeAsync(5);

    await rejected;
    expect(request).not.toHaveBeenCalled();
  });
});
