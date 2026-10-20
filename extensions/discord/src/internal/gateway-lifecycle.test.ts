// Discord tests cover gateway lifecycle plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayHeartbeatTimers } from "./gateway-lifecycle.js";

describe("GatewayHeartbeatTimers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not false-timeout when the first heartbeat fires near the interval boundary", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.95);

    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();
    const isAcked = vi.fn().mockReturnValue(false);
    const timers = new GatewayHeartbeatTimers();

    timers.start({
      intervalMs: 45_000,
      isAcked,
      onAckTimeout,
      onHeartbeat,
    });

    vi.advanceTimersByTime(42_750);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onAckTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_250);
    expect(onAckTimeout).not.toHaveBeenCalled();

    isAcked.mockReturnValue(true);
    vi.advanceTimersByTime(42_750);
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
    expect(onAckTimeout).not.toHaveBeenCalled();

    timers.stop();
  });

  it("fires an ACK timeout when a heartbeat is genuinely not acknowledged", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);

    const timers = new GatewayHeartbeatTimers();
    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();

    timers.start({
      intervalMs: 45_000,
      isAcked: () => false,
      onAckTimeout,
      onHeartbeat,
    });

    vi.advanceTimersByTime(0);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(45_000);
    expect(onAckTimeout).toHaveBeenCalledTimes(1);

    timers.stop();
  });

  it("stop cancels all pending timers", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const timers = new GatewayHeartbeatTimers();
    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();

    timers.start({
      intervalMs: 10_000,
      isAcked: () => true,
      onAckTimeout,
      onHeartbeat,
    });

    timers.stop();
    vi.advanceTimersByTime(100_000);

    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onAckTimeout).not.toHaveBeenCalled();
  });
});
