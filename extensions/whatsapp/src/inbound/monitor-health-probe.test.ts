import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSock,
  installWebMonitorInboxUnitTestHooks,
  startInboxMonitor,
} from "../monitor-inbox.test-harness.js";

installWebMonitorInboxUnitTestHooks();

describe("WA health probe", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes getHealthProbeState on the listener", async () => {
    const onMessage = vi.fn();
    const sock = getSock();
    sock.fetchStatus = vi.fn().mockResolvedValue({ status: "Hey there!" });

    const { listener } = await startInboxMonitor(onMessage);

    expect(typeof listener.getHealthProbeState).toBe("function");
    // Allow the initial probe to settle
    await vi.advanceTimersByTimeAsync(50);

    const state = listener.getHealthProbeState();
    expect(state.ok).toBe(true);
    expect(state.lastProbeAt).toBeTypeOf("number");

    await listener.close();
  });

  it("marks probe as failed when fetchStatus rejects", async () => {
    const onMessage = vi.fn();
    const sock = getSock();
    sock.fetchStatus = vi.fn().mockRejectedValue(new Error("server down"));

    const { listener } = await startInboxMonitor(onMessage);
    await vi.advanceTimersByTimeAsync(50);

    const state = listener.getHealthProbeState();
    expect(state.ok).toBe(false);
    expect(state.error).toContain("server down");

    await listener.close();
  });

  it("marks probe as failed on timeout", async () => {
    const onMessage = vi.fn();
    const sock = getSock();
    // Never resolves → triggers timeout
    sock.fetchStatus = vi.fn().mockReturnValue(new Promise(() => {}));

    const { listener } = await startInboxMonitor(onMessage);
    // Advance past the 10s timeout
    await vi.advanceTimersByTimeAsync(11_000);

    const state = listener.getHealthProbeState();
    expect(state.ok).toBe(false);
    expect(state.error).toContain("probe timeout");

    await listener.close();
  });

  it("runs probe periodically every 60s", async () => {
    const onMessage = vi.fn();
    const sock = getSock();
    const fetchStatus = vi.fn().mockResolvedValue({ status: "ok" });
    sock.fetchStatus = fetchStatus;

    const { listener } = await startInboxMonitor(onMessage);
    // Initial probe fires immediately
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    // Advance 60s for second probe
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    // Advance another 60s for third
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);

    await listener.close();
  });

  it("does not accumulate probes when fetchStatus hangs", async () => {
    const onMessage = vi.fn();
    const sock = getSock();
    // fetchStatus never resolves — simulates hung connection
    const fetchStatus = vi.fn().mockReturnValue(new Promise(() => {}));
    sock.fetchStatus = fetchStatus;

    const { listener } = await startInboxMonitor(onMessage);
    // Advance past timeout (10s) so first probe times out
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    // Advance 60s — interval fires but probeInFlight should block a new call
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    // Advance another 60s — still blocked
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("clears interval on close", async () => {
    const onMessage = vi.fn();
    const sock = getSock();
    const fetchStatus = vi.fn().mockResolvedValue({ status: "ok" });
    sock.fetchStatus = fetchStatus;

    const { listener } = await startInboxMonitor(onMessage);
    await vi.advanceTimersByTimeAsync(50);
    const callsBefore = fetchStatus.mock.calls.length;

    await listener.close();

    // Advance time — no more probes should fire
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchStatus).toHaveBeenCalledTimes(callsBefore);
  });
});
