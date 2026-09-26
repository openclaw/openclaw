// Slack tests cover provider.reconnect plugin behavior.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gracefulStopSlackApp,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  registerSlackSocketModeConnectionDiagnostics,
  waitForSlackSocketDisconnect,
} from "./reconnect-policy.js";

function statusCallAt(setStatus: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const call = setStatus.mock.calls[index];
  if (!call) {
    throw new Error(`expected status call ${index}`);
  }
  const [status] = call;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`expected status call ${index} payload`);
  }
  return status as Record<string, unknown>;
}

describe("slack socket reconnect helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks socket mode healthy without seeding event liveness on connect", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_000);

    publishSlackConnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    const status = statusCallAt(setStatus, 0);
    expect(status?.connected).toBe(true);
    expect(status?.running).toBe(true);
    expect(status?.lastConnectedAt).toBe(1_711_406_400_000);
    expect(status?.lifecycle).toBe("ready");
    expect(status?.lastError).toBeNull();
    expect(status?.terminalDisconnect).toBeUndefined();
    expect(status).not.toHaveProperty("lastEventAt");
  });

  it("marks socket mode disconnected when an error closes the socket", () => {
    const setStatus = vi.fn();
    const err = new Error("dns down");
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_401_000);

    publishSlackDisconnectedStatus(setStatus, err);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "recovering",
      lastDisconnect: {
        at: 1_711_406_401_000,
        error: "dns down",
      },
      lastError: "dns down",
    });
  });

  it("marks socket mode disconnected without error when the socket closes cleanly", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_402_000);

    publishSlackDisconnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      lifecycle: "recovering",
      lastDisconnect: {
        at: 1_711_406_402_000,
      },
      lastError: null,
    });
  });

  it("formats shared Socket Mode connection warnings with remediation", () => {
    expect(formatSlackSocketModeSharedConnectionWarning(2)).toContain(
      "slack socket mode reports 2 active connections for this Slack app",
    );
    expect(formatSlackSocketModeSharedConnectionWarning(2)).toContain(
      "equivalent routing and authorization",
    );
  });

  it("warns once when Slack reports a shared Socket Mode app token", () => {
    const client = new EventEmitter();
    const onSharedConnection = vi.fn();
    const unregister = registerSlackSocketModeConnectionDiagnostics({
      app: { receiver: { client } },
      onSharedConnection,
    });

    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "events_api", payload: { text: "hello" } })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: "2" })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 1 })),
      false,
    );
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 4 })),
      true,
    );
    client.emit("ws_message", JSON.stringify({ type: "hello", num_connections: 2 }), false);
    client.emit("ws_message", JSON.stringify({ type: "hello", num_connections: 3 }), false);

    expect(onSharedConnection).toHaveBeenCalledTimes(1);
    expect(onSharedConnection).toHaveBeenCalledWith(2);

    unregister();
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "hello", num_connections: 2 })),
      false,
    );
    expect(onSharedConnection).toHaveBeenCalledTimes(1);
    expect(client.listenerCount("ws_message")).toBe(0);
  });

  it("installs the disconnect waiter before socket start completes", async () => {
    const client = new EventEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(async () => {
        client.emit("disconnected");
      }),
    };
    const onStarted = vi.fn();

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted,
      }),
    ).resolves.toEqual({ event: "disconnect" });

    expect(app.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("cancels the disconnect waiter when onStarted throws", async () => {
    const client = new EventEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockResolvedValue(undefined),
    };
    const err = new Error("status sink failed");

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted: () => {
          throw err;
        },
      }),
    ).rejects.toThrow("status sink failed");

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("preserves error payload from unable_to_socket_mode_start event", async () => {
    const client = new EventEmitter();
    const app = { receiver: { client } };
    const err = new Error("invalid_auth");

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("unable_to_socket_mode_start", err);

    await expect(waiter).resolves.toEqual({
      event: "unable_to_socket_mode_start",
      error: err,
    });
  });

  it("uses socket start event error when Bolt rejects without detail", async () => {
    const client = new EventEmitter();
    const err = new Error("missing_scope");
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(() => {
        client.emit("unable_to_socket_mode_start", err);
        throw new Error();
      }),
    };

    await expect(startSlackSocketAndWaitForDisconnect({ app: app as never })).rejects.toThrow(
      "missing_scope",
    );

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("marks the socket client as shutting down before stop runs", async () => {
    const app = {
      receiver: { client: { shuttingDown: false } },
      stop: vi.fn().mockImplementation(async () => {
        expect(app.receiver.client.shuttingDown).toBe(true);
      }),
    };

    await gracefulStopSlackApp(app);

    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.receiver.client.shuttingDown).toBe(true);
  });
});
