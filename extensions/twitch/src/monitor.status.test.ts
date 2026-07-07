// Twitch tests cover the monitor transport-status bridge behavior.
import { describe, expect, it, vi } from "vitest";
import type { TwitchAccountConfig } from "./types.js";

const hoisted = vi.hoisted(() => {
  const connectionHandlers: Array<(status: { connected: boolean; reason?: string }) => void> = [];
  return {
    connectionHandlers,
    getClient: vi.fn(async () => ({})),
    onMessage: vi.fn(() => () => {}),
    onConnectionChange: vi.fn(
      (_account: unknown, handler: (status: { connected: boolean; reason?: string }) => void) => {
        connectionHandlers.push(handler);
        return () => {};
      },
    ),
  };
});

vi.mock("./client-manager-registry.js", () => ({
  getOrCreateClientManager: () => ({
    getClient: hoisted.getClient,
    onMessage: hoisted.onMessage,
    onConnectionChange: hoisted.onConnectionChange,
  }),
}));

vi.mock("./runtime.js", () => ({
  getTwitchRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
      shouldLogVerbose: () => false,
    },
  }),
}));

const { monitorTwitchProvider } = await import("./monitor.js");

function buildAccount(): TwitchAccountConfig {
  return {
    username: "testbot",
    accessToken: "oauth:test-token",
    clientId: "test-client-id",
    channel: "testchannel",
    enabled: true,
  };
}

describe("monitorTwitchProvider transport-status bridge", () => {
  it("emits connected on start and forwards ChatClient disconnects to the status sink", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const abort = new AbortController();

    const { stop } = await monitorTwitchProvider({
      account: buildAccount(),
      accountId: "default",
      config: {},
      runtime: { error: vi.fn() } as never,
      abortSignal: abort.signal,
      statusSink: (patch) => patches.push({ ...patch }),
    });

    // getClient resolving marks the transport connected.
    expect(patches.some((patch) => patch.connected === true)).toBe(true);
    expect(hoisted.onConnectionChange).toHaveBeenCalledOnce();

    // A persistent ChatClient disconnect flows through onConnectionChange.
    hoisted.connectionHandlers.at(-1)?.({ connected: false, reason: "connection reset" });
    const dropped = patches.at(-1);
    expect(dropped?.connected).toBe(false);
    expect(dropped?.lastError).toBe("connection reset");
    // We intentionally do not publish lastTransportActivityAt (would trip the
    // health monitor's stale-socket restart without a real heartbeat).
    expect(dropped).not.toHaveProperty("lastTransportActivityAt");

    stop();
  });

  it("clears the prior disconnect error when the transport reconnects", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const abort = new AbortController();

    const { stop } = await monitorTwitchProvider({
      account: buildAccount(),
      accountId: "default",
      config: {},
      runtime: { error: vi.fn() } as never,
      abortSignal: abort.signal,
      statusSink: (patch) => patches.push({ ...patch }),
    });
    const notify = hoisted.connectionHandlers.at(-1);

    // Drop the transport (records an error), then reconnect.
    notify?.({ connected: false, reason: "connection reset" });
    expect(patches.at(-1)?.lastError).toBe("connection reset");

    notify?.({ connected: true });
    // Status patches merge, so the reconnect must explicitly null out the error.
    const reconnected = patches.at(-1);
    expect(reconnected?.connected).toBe(true);
    expect(reconnected?.lastError).toBe(null);

    stop();
  });

  it("preserves the auth-failure error across Twurple's reasonless retry disconnect", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const abort = new AbortController();

    const { stop } = await monitorTwitchProvider({
      account: buildAccount(),
      accountId: "default",
      config: {},
      runtime: { error: vi.fn() } as never,
      abortSignal: abort.signal,
      statusSink: (patch) => patches.push({ ...patch }),
    });
    const notify = hoisted.connectionHandlers.at(-1);

    // onAuthenticationFailure surfaces the auth error as disconnected+error.
    notify?.({ connected: false, reason: "Login authentication failed" });
    expect(patches.at(-1)?.lastError).toBe("Login authentication failed");

    // Twurple's auth-retry immediately fires a reasonless manual onDisconnect
    // (reconnect = quit()+connect()). Its patch must omit lastError so the merge
    // preserves the auth-failure text rather than nulling it out.
    notify?.({ connected: false });
    const retryDrop = patches.at(-1);
    expect(retryDrop?.connected).toBe(false);
    expect(retryDrop).not.toHaveProperty("lastError");

    stop();
  });
});
