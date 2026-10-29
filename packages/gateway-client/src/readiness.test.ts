import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGatewayClientWhenEventLoopReady } from "./readiness.js";

describe("startGatewayClientWhenEventLoopReady", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("honors the client environment deadline when the event loop stalls", async () => {
    const client = { start: vi.fn() };
    const completed = vi.fn();
    const readiness = startGatewayClientWhenEventLoopReady(client, {
      clientOptions: {
        env: { OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "6000" },
      },
    });
    void readiness.then(completed);

    // One tick detects the stall; the next reaches the configured deadline.
    vi.setSystemTime(Date.now() + 5_998);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledExactlyOnceWith({
      ready: false,
      aborted: false,
      elapsedMs: 6_000,
      checks: 2,
      maxDriftMs: 5_998,
    });
    expect(client.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the client only after the event loop is responsive", async () => {
    const client = { start: vi.fn() };

    const promise = startGatewayClientWhenEventLoopReady(client, { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(1);
    expect(client.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const readiness = await promise;
    expect(readiness.ready).toBe(true);
    expect(readiness.aborted).toBe(false);

    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it("does not start the client after an aborted readiness wait", async () => {
    const client = { start: vi.fn() };
    const controller = new AbortController();

    const promise = startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: 100,
      signal: controller.signal,
    });
    controller.abort();

    const readiness = await promise;
    expect(readiness.ready).toBe(false);
    expect(readiness.aborted).toBe(true);
    expect(client.start).not.toHaveBeenCalled();
  });
});
