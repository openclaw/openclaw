import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gracefulStopSlackApp,
  publishSlackDisconnectedStatus,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  registerSlackSocketModeConnectionDiagnostics,
} from "./reconnect-policy.js";

describe("slack socket reconnect helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("warns once when Slack reports a shared Socket Mode app token", () => {
    const client = new EventEmitter();
    const onSharedConnection = vi.fn();
    const unregister = registerSlackSocketModeConnectionDiagnostics({
      app: { receiver: { client } },
      onSharedConnection,
    });

    const emit = (payload: object, binary = false) =>
      client.emit("ws_message", Buffer.from(JSON.stringify(payload)), binary);
    emit({ type: "events_api", payload: { text: "hello" } });
    emit({ type: "hello", num_connections: "2" });
    emit({ type: "hello", num_connections: 1 });
    emit({ type: "hello", num_connections: 4 }, true);
    client.emit("ws_message", JSON.stringify({ type: "hello", num_connections: 2 }), false);
    client.emit("ws_message", JSON.stringify({ type: "hello", num_connections: 3 }), false);

    expect(onSharedConnection).toHaveBeenCalledTimes(1);
    expect(onSharedConnection).toHaveBeenCalledWith(2);
    const warning = formatSlackSocketModeSharedConnectionWarning(
      onSharedConnection.mock.calls[0]?.[0],
    );
    expect(warning).toContain("2 active connections");
    expect(warning).toContain("equivalent routing and authorization");

    unregister();
    emit({ type: "hello", num_connections: 2 });
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
        app,
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
        app,
        onStarted: () => {
          throw err;
        },
      }),
    ).rejects.toThrow("status sink failed");

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
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

    await expect(startSlackSocketAndWaitForDisconnect({ app })).rejects.toThrow("missing_scope");

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
