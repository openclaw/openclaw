import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingMonitor } from "./monitor.js";
import type { OscClient } from "./osc-client.js";

describe("RecordingMonitor", () => {
  let monitor: RecordingMonitor;
  let mockClient: { getState: ReturnType<typeof vi.fn> };
  let mockAlert: (message: string, sessionKey: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = { getState: vi.fn() };
    mockAlert = vi.fn<(message: string, sessionKey: string) => void>();
    monitor = new RecordingMonitor({
      client: mockClient as unknown as OscClient,
      onAlert: mockAlert,
      lowBatteryThreshold: 15,
      lowStorageMB: 500,
      pollIntervalMs: 30000,
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("does not poll when not started", () => {
    expect(mockClient.getState).not.toHaveBeenCalled();
  });

  it("polls after start and alerts on low battery", async () => {
    mockClient.getState.mockResolvedValue({
      state: {
        batteryLevel: 0.1,
        _storageRemainInMB: 1000,
        _cardState: "pass",
      },
    });

    monitor.start("session-123");
    await vi.advanceTimersByTimeAsync(30000);

    expect(mockClient.getState).toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith(expect.stringContaining("battery"), "session-123");
  });

  it("alerts on low storage", async () => {
    mockClient.getState.mockResolvedValue({
      state: {
        batteryLevel: 0.8,
        _storageRemainInMB: 100,
        _cardState: "pass",
      },
    });

    monitor.start("session-123");
    await vi.advanceTimersByTimeAsync(30000);

    expect(mockAlert).toHaveBeenCalledWith(expect.stringContaining("storage"), "session-123");
  });

  it("alerts on camera disconnect and enters backoff", async () => {
    mockClient.getState
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    monitor.start("session-123");
    // First poll — fails once, disconnectCount=1 (no alert yet)
    await vi.advanceTimersByTimeAsync(30000);
    // Second poll — fails again, disconnectCount=2, alerts
    await vi.advanceTimersByTimeAsync(30000);

    expect(mockAlert).toHaveBeenCalledWith(expect.stringContaining("disconnected"), "session-123");
  });

  it("stops polling on stop()", async () => {
    mockClient.getState.mockResolvedValue({
      state: { batteryLevel: 0.8, _storageRemainInMB: 1000, _cardState: "pass" },
    });

    monitor.start("session-123");
    monitor.stop();
    await vi.advanceTimersByTimeAsync(60000);

    expect(mockClient.getState).not.toHaveBeenCalled();
  });
});
