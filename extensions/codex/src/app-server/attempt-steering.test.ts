// Codex tests cover attempt steering plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexSteeringQueue } from "./attempt-steering.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("Codex app-server steering queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves queued steering only after turn/steer is accepted", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: () => undefined,
      signal: new AbortController().signal,
    });

    const queued = queue.queue("accepted", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await queued;

    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "accepted", text_elements: [] }],
    });
  });

  it("steers a complete image reply before releasing pending input", async () => {
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const answerPendingUserInput = vi.fn(() => true);
    const cancelPendingUserInput = vi.fn(() => true);
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: () => ({
        answer: answerPendingUserInput,
        cancel: cancelPendingUserInput,
      }),
      signal: new AbortController().signal,
    });

    const queued = queue.queue("compare these", {
      images: [
        { type: "image", data: PNG_1X1, mimeType: "image/png" },
        { type: "image", data: PNG_1X1, mimeType: "image/png" },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    await queued;

    expect(answerPendingUserInput).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "compare these", text_elements: [] },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
      ],
    });
    expect(cancelPendingUserInput).toHaveBeenCalledOnce();
    expect(request.mock.invocationCallOrder[0]!).toBeLessThan(
      cancelPendingUserInput.mock.invocationCallOrder[0]!,
    );
  });

  it("claims pending input before a later queued message can answer it", async () => {
    let resolveImageSteer: (() => void) | undefined;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ turnId: string }>((resolve) => {
            resolveImageSteer = () => resolve({ turnId: "turn-1" });
          }),
      )
      .mockResolvedValue({ turnId: "turn-1" });
    const cancelPendingUserInput = vi.fn(() => true);
    let pendingClaimed = false;
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: () => {
        if (pendingClaimed) {
          return undefined;
        }
        pendingClaimed = true;
        return { answer: vi.fn(() => true), cancel: cancelPendingUserInput };
      },
      signal: new AbortController().signal,
    });

    const imageQueued = queue.queue("image reply", {
      images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
    });
    await vi.advanceTimersByTimeAsync(0);
    const laterQueued = queue.queue("later reply", { debounceMs: 0 });
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      input: [
        { type: "text", text: "image reply" },
        { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
      ],
    });

    resolveImageSteer?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([imageQueued, laterQueued]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      input: [{ type: "text", text: "later reply" }],
    });
    expect(cancelPendingUserInput).toHaveBeenCalledOnce();
  });

  it("releases pending input when an atomic image steer is rejected", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer this turn");
    });
    const answerPendingUserInput = vi.fn(() => true);
    const cancelPendingUserInput = vi.fn(() => true);
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: () => ({
        answer: answerPendingUserInput,
        cancel: cancelPendingUserInput,
      }),
      signal: new AbortController().signal,
    });

    await expect(
      queue.queue("compare this", {
        images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
      }),
    ).rejects.toThrow("cannot steer this turn");

    expect(answerPendingUserInput).not.toHaveBeenCalled();
    expect(cancelPendingUserInput).toHaveBeenCalledOnce();
  });

  it("rejects later steering behind a failed atomic image steer", async () => {
    let rejectImageSteer: ((error: Error) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<{ turnId: string }>((_resolve, reject) => {
          rejectImageSteer = reject;
        }),
    );
    const cancelPendingUserInput = vi.fn(() => true);
    let pendingClaimed = false;
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: () => {
        if (pendingClaimed) {
          return undefined;
        }
        pendingClaimed = true;
        return { answer: vi.fn(() => true), cancel: cancelPendingUserInput };
      },
      signal: new AbortController().signal,
    });

    const settled: string[] = [];
    const imageQueued = queue
      .queue("image reply", {
        images: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
      })
      .catch(() => {
        settled.push("image");
      });
    await vi.advanceTimersByTimeAsync(0);
    const laterQueued = queue.queue("later reply", { debounceMs: 0 }).catch(() => {
      settled.push("later");
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledOnce();
    rejectImageSteer?.(new Error("cannot steer this turn"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([imageQueued, laterQueued]);

    expect(request).toHaveBeenCalledOnce();
    expect(settled).toEqual(["image", "later"]);
    expect(cancelPendingUserInput).toHaveBeenCalledOnce();
  });

  it("rejects queued steering when turn/steer is rejected", async () => {
    const request = vi.fn(async () => {
      throw new Error("cannot steer a compact turn");
    });
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: () => undefined,
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

  it("batches queued steering after a nonzero debounce while the turn is active", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ turnId: "turn-1" }));
    const queue = createCodexSteeringQueue({
      client: { request } as never,
      threadId: "thread-1",
      turnId: "turn-1",
      claimPendingUserInput: () => undefined,
      signal: new AbortController().signal,
    });

    const firstQueued = queue.queue("first", { debounceMs: 5 });
    const secondQueued = queue.queue("second", { debounceMs: 5 });

    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
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
      claimPendingUserInput: () => undefined,
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
      claimPendingUserInput: () => ({
        answer: answerPendingUserInput,
        cancel: () => true,
      }),
      signal: new AbortController().signal,
    });

    await queue.queue("answer locally", { debounceMs: 0 });

    expect(answerPendingUserInput).toHaveBeenCalledWith("answer locally");
    expect(request).not.toHaveBeenCalled();
  });
});
