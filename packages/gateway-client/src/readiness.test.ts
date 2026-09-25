// Gateway Client tests cover readiness behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startGatewayClientWhenEventLoopReady,
  startGatewayClientWithReadinessWait,
} from "./readiness.js";

describe("startGatewayClientWithReadinessWait", () => {
  it("uses the injected client env when resolving the readiness timeout", async () => {
    const waitForReady = vi.fn(async () => ({
      ready: true,
      aborted: false,
      elapsedMs: 0,
      checks: 1,
      maxDriftMs: 0,
    }));
    const client = { start: vi.fn() };

    await startGatewayClientWithReadinessWait(waitForReady, client, {
      clientOptions: {
        env: { OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "6000" },
      },
    });

    expect(waitForReady).toHaveBeenCalledWith({
      maxWaitMs: 6_000,
      signal: undefined,
    });
    expect(client.start).toHaveBeenCalledTimes(1);
  });
});

describe("startGatewayClientWhenEventLoopReady", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the client only after the event loop is responsive", async () => {
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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
