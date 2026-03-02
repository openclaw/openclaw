/**
 * Unit tests for ConnectionManager.
 *
 * UserbotClient and SessionStore are fully mocked -- no real Telegram
 * connections or filesystem I/O.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { UserbotClient } from "./client.js";
import { ConnectionManager } from "./connection.js";
import type { ConnectionConfig } from "./connection.js";
import { UserbotAuthError } from "./errors.js";
import type { SessionStore } from "./session-store.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock UserbotClient with sensible defaults. */
function mockClient(overrides: Partial<Record<keyof UserbotClient, unknown>> = {}) {
  return {
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isConnected: vi.fn<() => boolean>().mockReturnValue(true),
    getMe: vi.fn().mockResolvedValue({
      id: 267619672,
      firstName: "Test",
      username: "testuser",
    }),
    getSessionString: vi.fn<() => string>().mockReturnValue("session-data-xyz"),
    getClient: vi.fn(),
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    deleteMessages: vi.fn(),
    forwardMessages: vi.fn(),
    reactToMessage: vi.fn(),
    pinMessage: vi.fn(),
    getHistory: vi.fn(),
    setTyping: vi.fn(),
    connectInteractive: vi.fn(),
    ...overrides,
  } as unknown as UserbotClient;
}

/** Create a mock SessionStore. */
function mockSessionStore(overrides: Partial<Record<keyof SessionStore, unknown>> = {}) {
  return {
    load: vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue("saved-session"),
    save: vi.fn<(id: string, s: string) => Promise<void>>().mockResolvedValue(undefined),
    clear: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    exists: vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true),
    getSessionPath: vi.fn<(id: string) => string>().mockReturnValue("/tmp/session"),
    credentialsDir: "/tmp",
    ...overrides,
  } as unknown as SessionStore;
}

/** Default test config. */
function defaultConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    apiId: 12345,
    apiHash: "abc123",
    accountId: "test-account",
    ...overrides,
  };
}

// We need to intercept UserbotClient construction inside ConnectionManager.
// Use vi.mock to replace the client module with a constructable mock.
const mockClientInstance = mockClient();

vi.mock("./client.js", () => ({
  UserbotClient: vi.fn().mockImplementation(function () {
    return mockClientInstance;
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConnectionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Reset mock client to defaults
    vi.mocked(mockClientInstance.connect).mockResolvedValue(undefined);
    vi.mocked(mockClientInstance.disconnect).mockResolvedValue(undefined);
    vi.mocked(mockClientInstance.isConnected).mockReturnValue(true);
    vi.mocked(mockClientInstance.getMe).mockResolvedValue({
      id: 267619672,
      firstName: "Test",
      username: "testuser",
    } as never);
    vi.mocked(mockClientInstance.getSessionString).mockReturnValue("session-data-xyz");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. Happy path start
  // -----------------------------------------------------------------------

  it("connects successfully and emits 'connected' with user info", async () => {
    const store = mockSessionStore();
    const mgr = new ConnectionManager(defaultConfig(), store);
    const events: Array<{ event: string; data: unknown }> = [];
    mgr.on("connected", (data) => events.push({ event: "connected", data }));

    const result = await mgr.start();

    expect(result).toBe(true);
    expect(store.load).toHaveBeenCalledWith("test-account");
    expect(mockClientInstance.connect).toHaveBeenCalledOnce();
    expect(mockClientInstance.getMe).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ username: "testuser", userId: 267619672 });
  });

  // -----------------------------------------------------------------------
  // 2. Missing session
  // -----------------------------------------------------------------------

  it("returns false and emits 'disconnected' when no session exists", async () => {
    const store = mockSessionStore({ load: vi.fn().mockResolvedValue(null) });
    const mgr = new ConnectionManager(defaultConfig(), store);
    const events: Array<{ event: string; data: unknown }> = [];
    mgr.on("disconnected", (data) => events.push({ event: "disconnected", data }));

    const result = await mgr.start();

    expect(result).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ reason: "no-session" });
    // Client should never be constructed
    expect(mockClientInstance.connect).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 3. Auth error on connect
  // -----------------------------------------------------------------------

  it("emits 'authError' and does not schedule reconnect on UserbotAuthError", async () => {
    const store = mockSessionStore();
    vi.mocked(mockClientInstance.connect).mockRejectedValueOnce(
      new UserbotAuthError("SESSION_REVOKED"),
    );

    const mgr = new ConnectionManager(defaultConfig(), store);
    const authEvents: unknown[] = [];
    const reconnectEvents: unknown[] = [];
    mgr.on("authError", (data) => authEvents.push(data));
    mgr.on("reconnecting", (data) => reconnectEvents.push(data));

    const result = await mgr.start();

    expect(result).toBe(false);
    expect(authEvents).toHaveLength(1);
    expect(reconnectEvents).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 4. Reconnection on generic error
  // -----------------------------------------------------------------------

  it("schedules reconnect and emits 'reconnecting' on transient error", async () => {
    const store = mockSessionStore();
    vi.mocked(mockClientInstance.connect).mockRejectedValueOnce(new Error("network timeout"));

    const mgr = new ConnectionManager(defaultConfig(), store);
    const reconnectEvents: unknown[] = [];
    mgr.on("reconnecting", (data) => reconnectEvents.push(data));

    const result = await mgr.start();

    expect(result).toBe(false);
    expect(reconnectEvents).toHaveLength(1);
    expect(reconnectEvents[0]).toEqual({ attempt: 1, delayMs: 0 });
  });

  // -----------------------------------------------------------------------
  // 5. Reconnection backoff timing
  // -----------------------------------------------------------------------

  it("uses correct backoff delays: 0, 5s, 5s, 30s, 30s, 30s, 2min, 2min", async () => {
    const store = mockSessionStore();
    // Every connect attempt fails with a transient error
    vi.mocked(mockClientInstance.connect).mockRejectedValue(new Error("fail"));

    const mgr = new ConnectionManager(
      defaultConfig({ reconnect: { maxAttempts: -1, alertAfterFailures: 100 } }),
      store,
    );
    const delays: number[] = [];
    mgr.on("reconnecting", (data: { delayMs: number }) => delays.push(data.delayMs));

    await mgr.start(); // failure 1 -> delay 0
    expect(delays).toEqual([0]);

    // Advance one step at a time through the backoff schedule
    await vi.advanceTimersByTimeAsync(1); // fires 0ms timer -> failure 2, schedules 5s
    expect(delays).toEqual([0, 5_000]);

    await vi.advanceTimersByTimeAsync(5_001); // fires 5s timer -> failure 3, schedules 5s
    expect(delays).toEqual([0, 5_000, 5_000]);

    await vi.advanceTimersByTimeAsync(5_001); // fires 5s timer -> failure 4, schedules 30s
    expect(delays).toEqual([0, 5_000, 5_000, 30_000]);

    await vi.advanceTimersByTimeAsync(30_001); // fires 30s timer -> failure 5, schedules 30s
    expect(delays).toEqual([0, 5_000, 5_000, 30_000, 30_000]);

    await vi.advanceTimersByTimeAsync(30_001); // fires 30s timer -> failure 6, schedules 30s
    expect(delays).toEqual([0, 5_000, 5_000, 30_000, 30_000, 30_000]);

    await vi.advanceTimersByTimeAsync(30_001); // fires 30s timer -> failure 7, schedules 2min
    expect(delays).toEqual([0, 5_000, 5_000, 30_000, 30_000, 30_000, 120_000]);

    await vi.advanceTimersByTimeAsync(120_001); // fires 2min timer -> failure 8, schedules 2min
    expect(delays).toEqual([0, 5_000, 5_000, 30_000, 30_000, 30_000, 120_000, 120_000]);
  });

  // -----------------------------------------------------------------------
  // 6. Alert after N failures
  // -----------------------------------------------------------------------

  it("emits 'alertNeeded' after configured number of consecutive failures", async () => {
    const store = mockSessionStore();
    vi.mocked(mockClientInstance.connect).mockRejectedValue(new Error("fail"));

    const mgr = new ConnectionManager(
      defaultConfig({ reconnect: { alertAfterFailures: 2 } }),
      store,
    );
    const alertEvents: unknown[] = [];
    mgr.on("alertNeeded", (data) => alertEvents.push(data));

    await mgr.start(); // failure 1 -- no alert yet
    expect(alertEvents).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1); // trigger reconnect attempt -> failure 2
    expect(alertEvents).toHaveLength(1);
    expect(alertEvents[0]).toEqual({ failures: 2 });
  });

  // -----------------------------------------------------------------------
  // 7. Graceful stop
  // -----------------------------------------------------------------------

  it("saves session, disconnects client, and emits 'disconnected' on stop", async () => {
    const store = mockSessionStore();
    const mgr = new ConnectionManager(defaultConfig(), store);
    await mgr.start();

    const disconnectEvents: unknown[] = [];
    mgr.on("disconnected", (data) => disconnectEvents.push(data));

    await mgr.stop();

    expect(mockClientInstance.getSessionString).toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledWith("test-account", "session-data-xyz");
    expect(mockClientInstance.disconnect).toHaveBeenCalled();
    expect(disconnectEvents).toHaveLength(1);
    expect(disconnectEvents[0]).toEqual({ reason: "stopped" });
    expect(mgr.getClient()).toBeNull();
  });

  // -----------------------------------------------------------------------
  // 8. Stop prevents reconnect
  // -----------------------------------------------------------------------

  it("clears reconnect timer and prevents further reconnects after stop", async () => {
    const store = mockSessionStore();
    vi.mocked(mockClientInstance.connect)
      .mockRejectedValueOnce(new Error("fail")) // initial start fails
      .mockResolvedValue(undefined); // subsequent would succeed

    const mgr = new ConnectionManager(defaultConfig(), store);
    const reconnectEvents: unknown[] = [];
    const connectedEvents: unknown[] = [];
    mgr.on("reconnecting", (data) => reconnectEvents.push(data));
    mgr.on("connected", (data) => connectedEvents.push(data));

    await mgr.start(); // schedules reconnect
    expect(reconnectEvents).toHaveLength(1);

    // Stop before the timer fires
    vi.mocked(mockClientInstance.isConnected).mockReturnValue(false);
    await mgr.stop();

    // Advance time well past the reconnect delay
    await vi.advanceTimersByTimeAsync(300_000);

    // No further reconnect events or connected events
    expect(reconnectEvents).toHaveLength(1);
    expect(connectedEvents).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 9. Health metrics
  // -----------------------------------------------------------------------

  it("returns accurate health metrics", async () => {
    const store = mockSessionStore();
    const mgr = new ConnectionManager(defaultConfig(), store);

    // Before connection
    const preHealth = mgr.health();
    expect(preHealth.connected).toBe(false);
    expect(preHealth.uptimeMs).toBe(0);
    expect(preHealth.reconnects).toBe(0);

    await mgr.start();

    const postHealth = mgr.health();
    expect(postHealth.connected).toBe(true);
    expect(postHealth.username).toBe("testuser");
    expect(postHealth.userId).toBe(267619672);
    expect(postHealth.reconnects).toBe(0);
  });

  it("increments reconnect count on each reconnect attempt", async () => {
    const store = mockSessionStore();
    // First two attempts fail, third succeeds
    vi.mocked(mockClientInstance.connect)
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue(undefined);

    const mgr = new ConnectionManager(defaultConfig(), store);
    await mgr.start(); // failure 1

    await vi.advanceTimersByTimeAsync(1); // reconnect attempt 1 fails (failure 2)
    await vi.advanceTimersByTimeAsync(5_001); // reconnect attempt 2 succeeds

    const health = mgr.health();
    expect(health.reconnects).toBe(2);
    expect(health.connected).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 10. Restart
  // -----------------------------------------------------------------------

  it("restart stops then starts, emitting lifecycle events", async () => {
    const store = mockSessionStore();
    const mgr = new ConnectionManager(defaultConfig(), store);
    await mgr.start();

    const events: string[] = [];
    mgr.on("disconnected", () => events.push("disconnected"));
    mgr.on("connected", () => events.push("connected"));

    const result = await mgr.restart();

    expect(result).toBe(true);
    expect(events).toEqual(["disconnected", "connected"]);
  });

  // -----------------------------------------------------------------------
  // Max retries
  // -----------------------------------------------------------------------

  it("stops reconnecting and emits 'disconnected' at max attempts", async () => {
    const store = mockSessionStore();
    vi.mocked(mockClientInstance.connect).mockRejectedValue(new Error("fail"));

    const mgr = new ConnectionManager(
      defaultConfig({ reconnect: { maxAttempts: 2, alertAfterFailures: 100 } }),
      store,
    );
    const disconnectEvents: unknown[] = [];
    mgr.on("disconnected", (data) => disconnectEvents.push(data));

    await mgr.start(); // failure 1, reconnectCount=0, schedules reconnect

    await vi.advanceTimersByTimeAsync(1); // reconnect fires, reconnectCount=1, fails, schedules again
    await vi.advanceTimersByTimeAsync(5_001); // reconnect fires, reconnectCount=2, fails -> max reached

    const maxRetryEvent = disconnectEvents.find(
      (e) => (e as { reason: string }).reason === "max-retries",
    );
    expect(maxRetryEvent).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Auth error during reconnect
  // -----------------------------------------------------------------------

  it("stops reconnecting on auth error during reconnect attempt", async () => {
    const store = mockSessionStore();
    vi.mocked(mockClientInstance.connect)
      .mockRejectedValueOnce(new Error("network")) // initial failure
      .mockRejectedValueOnce(new UserbotAuthError("AUTH_KEY_UNREGISTERED")); // reconnect auth error

    const mgr = new ConnectionManager(defaultConfig(), store);
    const authEvents: unknown[] = [];
    const reconnectEvents: unknown[] = [];
    mgr.on("authError", (data) => authEvents.push(data));
    mgr.on("reconnecting", (data) => reconnectEvents.push(data));

    await mgr.start(); // fails with network error -> schedules reconnect
    expect(reconnectEvents).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1); // reconnect fires -> auth error

    expect(authEvents).toHaveLength(1);
    // Should not schedule another reconnect
    expect(reconnectEvents).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // bigint user ID
  // -----------------------------------------------------------------------

  it("handles bigint user IDs from getMe", async () => {
    const store = mockSessionStore();
    vi.mocked(mockClientInstance.getMe).mockResolvedValue({
      id: BigInt("9876543210"),
      firstName: "Big",
      username: "biguser",
    } as never);

    const mgr = new ConnectionManager(defaultConfig(), store);
    await mgr.start();

    const health = mgr.health();
    expect(health.userId).toBe(9876543210);
    expect(health.username).toBe("biguser");
  });
});
