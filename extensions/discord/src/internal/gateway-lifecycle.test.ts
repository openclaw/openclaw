import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayHeartbeatTimers } from "./gateway-lifecycle.js";

describe("GatewayHeartbeatTimers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not false-timeout when first heartbeat fires near the end of the random-delay window", () => {
    // This is the core bug: with the old setInterval approach, if random() ≈ 1.0
    // the first heartbeat fires at ~intervalMs, and the first setInterval tick
    // fires at intervalMs — before the ACK can arrive, causing a false timeout.
    vi.useFakeTimers();

    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();
    const isAcked = vi.fn();

    const timers = new GatewayHeartbeatTimers();

    // random() = 0.95 → first heartbeat at 42750ms (of 45000ms interval)
    timers.start({
      intervalMs: 45_000,
      isAcked,
      onAckTimeout,
      onHeartbeat,
      random: () => 0.95,
    });

    // isAcked starts as false (no heartbeat sent yet, so no ACK expected)
    isAcked.mockReturnValue(false);

    // Advance to just after the first heartbeat fires (42750ms)
    vi.advanceTimersByTime(42_750);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(onAckTimeout).not.toHaveBeenCalled();

    // With the OLD code (setInterval), the first interval tick at 45000ms would
    // check isAcked() before the ACK has time to arrive, triggering false timeout.
    //
    // With the NEW code (recursive setTimeout), the next check is at
    // 42750 + 45000 = 87750ms, giving plenty of time for the ACK.

    // Advance to 45000ms — with old code, this would trigger false timeout
    vi.advanceTimersByTime(2_250); // total: 45000ms
    expect(onAckTimeout).not.toHaveBeenCalled();

    // Now simulate the ACK arriving (as it would in real usage)
    isAcked.mockReturnValue(true);

    // Advance to when the next heartbeat should fire (87750ms)
    vi.advanceTimersByTime(42_750); // total: 87750ms
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
    expect(onAckTimeout).not.toHaveBeenCalled();

    timers.stop();
  });

  it("fires ack timeout when heartbeat is genuinely not acked", () => {
    vi.useFakeTimers();

    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();
    const isAcked = vi.fn().mockReturnValue(false);

    const timers = new GatewayHeartbeatTimers();

    // First heartbeat at 0ms (random = 0)
    timers.start({
      intervalMs: 45_000,
      isAcked,
      onAckTimeout,
      onHeartbeat,
      random: () => 0,
    });

    // First heartbeat fires immediately
    vi.advanceTimersByTime(0);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    // After full interval with no ACK → should timeout
    vi.advanceTimersByTime(45_000);
    expect(onAckTimeout).toHaveBeenCalledTimes(1);

    timers.stop();
  });

  it("sends heartbeats at regular intervals after the initial random delay", () => {
    vi.useFakeTimers();

    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();
    const isAcked = vi.fn().mockReturnValue(true);

    const timers = new GatewayHeartbeatTimers();

    timers.start({
      intervalMs: 10_000,
      isAcked,
      onAckTimeout,
      onHeartbeat,
      random: () => 0.5, // first heartbeat at 5000ms
    });

    // First heartbeat at 5000ms
    vi.advanceTimersByTime(5_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);

    // Second at 15000ms (5000 + 10000)
    vi.advanceTimersByTime(10_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(2);

    // Third at 25000ms
    vi.advanceTimersByTime(10_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(3);

    // No ack timeouts because isAcked returns true
    expect(onAckTimeout).not.toHaveBeenCalled();

    timers.stop();
  });

  it("stop() cancels all pending timers", () => {
    vi.useFakeTimers();

    const onHeartbeat = vi.fn();
    const onAckTimeout = vi.fn();
    const isAcked = vi.fn().mockReturnValue(true);

    const timers = new GatewayHeartbeatTimers();

    timers.start({
      intervalMs: 10_000,
      isAcked,
      onAckTimeout,
      onHeartbeat,
      random: () => 0.5,
    });

    timers.stop();

    vi.advanceTimersByTime(100_000);
    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onAckTimeout).not.toHaveBeenCalled();
  });
});
