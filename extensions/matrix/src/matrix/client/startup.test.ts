import { describe, expect, it, vi } from "vitest";
import { MATRIX_CLIENT_STARTUP_GRACE_MS, startMatrixClientWithGrace } from "./startup.js";

describe("startMatrixClientWithGrace", () => {
  it("resolves after grace when start loop keeps running", async () => {
    vi.useFakeTimers();
    const client = {
      start: vi.fn().mockReturnValue(new Promise<void>(() => {})),
    };
    const startPromise = startMatrixClientWithGrace({ client });
    await vi.advanceTimersByTimeAsync(MATRIX_CLIENT_STARTUP_GRACE_MS);
    await expect(startPromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("rejects when startup fails during grace", async () => {
    vi.useFakeTimers();
    const startError = new Error("invalid token");
    const client = {
      start: vi.fn().mockRejectedValue(startError),
    };
    const startPromise = startMatrixClientWithGrace({ client });
    const startupExpectation = expect(startPromise).rejects.toBe(startError);
    await vi.advanceTimersByTimeAsync(MATRIX_CLIENT_STARTUP_GRACE_MS);
    await startupExpectation;
    vi.useRealTimers();
  });

  it("calls onError for late failures after startup returns", async () => {
    vi.useFakeTimers();
    const lateError = new Error("late disconnect");
    let rejectStart: ((err: unknown) => void) | undefined;
    const startLoop = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    const onError = vi.fn();
    const client = {
      start: vi.fn().mockReturnValue(startLoop),
    };
    const startPromise = startMatrixClientWithGrace({ client, onError });
    await vi.advanceTimersByTimeAsync(MATRIX_CLIENT_STARTUP_GRACE_MS);
    await expect(startPromise).resolves.toBeUndefined();

    rejectStart?.(lateError);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(lateError);
    vi.useRealTimers();
  });
});
