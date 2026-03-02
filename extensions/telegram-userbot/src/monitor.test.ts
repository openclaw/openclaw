import { describe, expect, it, vi, beforeEach } from "vitest";
import { incrementMetric, getMetrics, resetMetrics, probeConnection } from "./monitor.js";

// ---------------------------------------------------------------------------
// Mock ConnectionManager + UserbotClient
// ---------------------------------------------------------------------------

const mockMe = { id: 12345n, username: "testuser" };
const mockClient = {
  isConnected: vi.fn().mockReturnValue(true),
  getMe: vi.fn().mockResolvedValue(mockMe),
};
const mockManager = {
  getClient: vi.fn().mockReturnValue(mockClient),
};

vi.mock("./channel.js", () => ({
  getConnectionManager: vi.fn((accountId: string) => {
    if (accountId === "missing") return undefined;
    return mockManager;
  }),
}));

// ---------------------------------------------------------------------------
// Metric counters
// ---------------------------------------------------------------------------

describe("metric counters", () => {
  beforeEach(() => {
    resetMetrics("test");
  });

  it("starts with all zeros", () => {
    const m = getMetrics("test");
    expect(m).toEqual({
      messagesSent: 0,
      messagesReceived: 0,
      errors: 0,
      floodWaits: 0,
      reconnects: 0,
    });
  });

  it("increments individual counters", () => {
    incrementMetric("test", "messagesSent");
    incrementMetric("test", "messagesSent");
    incrementMetric("test", "messagesReceived", 3);
    incrementMetric("test", "errors");
    incrementMetric("test", "floodWaits");
    incrementMetric("test", "reconnects", 2);

    const m = getMetrics("test");
    expect(m.messagesSent).toBe(2);
    expect(m.messagesReceived).toBe(3);
    expect(m.errors).toBe(1);
    expect(m.floodWaits).toBe(1);
    expect(m.reconnects).toBe(2);
  });

  it("isolates metrics per account", () => {
    incrementMetric("acct1", "messagesSent", 5);
    incrementMetric("acct2", "messagesSent", 10);

    expect(getMetrics("acct1").messagesSent).toBe(5);
    expect(getMetrics("acct2").messagesSent).toBe(10);
  });

  it("resets metrics for an account", () => {
    incrementMetric("test", "messagesSent", 100);
    resetMetrics("test");
    expect(getMetrics("test").messagesSent).toBe(0);
  });

  it("returns a copy, not a reference", () => {
    incrementMetric("test", "messagesSent");
    const m1 = getMetrics("test");
    incrementMetric("test", "messagesSent");
    const m2 = getMetrics("test");
    expect(m1.messagesSent).toBe(1);
    expect(m2.messagesSent).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

describe("probeConnection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.isConnected.mockReturnValue(true);
    mockClient.getMe.mockResolvedValue(mockMe);
  });

  it("returns ok with user info on success", async () => {
    const result = await probeConnection("default");
    expect(result.ok).toBe(true);
    expect(result.username).toBe("testuser");
    expect(result.userId).toBe(12345);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error when no connection manager", async () => {
    const result = await probeConnection("missing");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No connection manager");
  });

  it("returns error when client is disconnected", async () => {
    mockClient.isConnected.mockReturnValue(false);
    const result = await probeConnection("default");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("returns error when getMe throws", async () => {
    mockClient.getMe.mockRejectedValueOnce(new Error("NETWORK_ERROR"));
    const result = await probeConnection("default");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("NETWORK_ERROR");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
