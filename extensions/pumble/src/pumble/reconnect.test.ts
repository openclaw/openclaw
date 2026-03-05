import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithReconnect } from "./reconnect.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runWithReconnect", () => {
  it("retries after connectFn resolves (normal close)", async () => {
    let callCount = 0;
    const abort = new AbortController();
    const connectFn = vi.fn(async () => {
      callCount++;
      if (callCount >= 3) {
        abort.abort();
      }
    });

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      initialDelayMs: 1,
    });

    expect(connectFn).toHaveBeenCalledTimes(3);
  });

  it("retries after connectFn throws (connection error)", async () => {
    let callCount = 0;
    const abort = new AbortController();
    const onError = vi.fn();
    const connectFn = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("fetch failed");
      }
      abort.abort();
    });

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      onError,
      initialDelayMs: 1,
    });

    expect(connectFn).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "fetch failed" }));
  });

  it("uses exponential backoff on consecutive errors, capped at maxDelayMs", async () => {
    const abort = new AbortController();
    const delays: number[] = [];
    let callCount = 0;
    const connectFn = vi.fn(async () => {
      callCount++;
      if (callCount >= 6) {
        abort.abort();
        return;
      }
      throw new Error("connection refused");
    });

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      onReconnect: (delayMs) => delays.push(delayMs),
      initialDelayMs: 1,
      maxDelayMs: 10,
    });

    expect(connectFn).toHaveBeenCalledTimes(6);
    expect(delays).toEqual([1, 2, 4, 8, 10]);
  });

  it("resets backoff after successful connection", async () => {
    const abort = new AbortController();
    const delays: number[] = [];
    let callCount = 0;
    const connectFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("first failure");
      }
      if (callCount === 2) {
        return;
      }
      if (callCount === 3) {
        throw new Error("second failure");
      }
      abort.abort();
    });

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      onReconnect: (delayMs) => delays.push(delayMs),
      initialDelayMs: 1,
      maxDelayMs: 60_000,
    });

    expect(connectFn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1, 1, 1]);
  });

  it("stops immediately when abort signal is pre-fired", async () => {
    const abort = new AbortController();
    abort.abort();
    const connectFn = vi.fn(async () => {});

    await runWithReconnect(connectFn, { abortSignal: abort.signal });

    expect(connectFn).not.toHaveBeenCalled();
  });

  it("stops after current connection when abort fires mid-connection", async () => {
    const abort = new AbortController();
    const connectFn = vi.fn(async () => {
      abort.abort();
    });

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      initialDelayMs: 1,
    });

    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it("abort signal interrupts backoff sleep immediately", async () => {
    const abort = new AbortController();
    const connectFn = vi.fn(async () => {
      setTimeout(() => abort.abort(), 10);
    });

    const start = Date.now();
    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      initialDelayMs: 60_000,
    });
    const elapsed = Date.now() - start;

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(5000);
  });

  it("applies jitter to reconnect delay when configured", async () => {
    const abort = new AbortController();
    const delays: number[] = [];
    let callCount = 0;
    const connectFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("connection refused");
      }
      abort.abort();
    });

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      onReconnect: (delayMs) => delays.push(delayMs),
      initialDelayMs: 10,
      jitterRatio: 0.5,
      random: () => 1,
    });

    expect(connectFn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([15]);
  });

  it("supports strategy hook to stop reconnecting after failure", async () => {
    const onReconnect = vi.fn();
    const connectFn = vi.fn(async () => {
      throw new Error("fatal");
    });

    await runWithReconnect(connectFn, {
      initialDelayMs: 1,
      onReconnect,
      shouldReconnect: (params) => params.outcome !== "rejected",
    });

    expect(connectFn).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
