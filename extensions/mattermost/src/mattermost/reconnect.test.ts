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
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    expect(connectFn).toHaveBeenCalledTimes(6);
    // 5 errors produce delays: 100, 200, 400, 800, 1000(cap)
    // 6th succeeds -> delay resets to 100
    // But 6th also aborts → onReconnect NOT called (abort check fires first)
    expect(delays).toEqual([100, 200, 400, 800, 1000]);
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
        return; // success
      }
      if (callCount === 3) {
        throw new Error("second failure");
      }
      abort.abort();
    });

    await runWithReconnect(connectFn, {
      abortSignal: abort.signal,
      onReconnect: (delayMs) => delays.push(delayMs),
      initialDelayMs: 100,
      maxDelayMs: 60_000,
    });

    expect(connectFn).toHaveBeenCalledTimes(4);
    // call 1: fail -> delay 100
    // call 2: success → delay resets to 100
    // call 3: fail -> delay 100 (reset held)
    // call 4: success + abort → no onReconnect
    expect(delays).toEqual([100, 100, 100]);
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
      // Schedule abort to fire 10ms into the 60s sleep
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
});
