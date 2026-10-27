import { EventEmitter } from "node:events";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  createSlackBoltApp,
  gracefulStopSlackApp,
  publishSlackDisconnectedStatus,
  resolveSlackBoltInterop,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketModeSharedConnectionWarning,
  isNonRecoverableSlackAuthError,
  registerSlackSocketModeConnectionDiagnostics,
} from "./reconnect-policy.js";

const socketOptions = {
  slackMode: "socket",
  token: "xoxb-test",
  appToken: "xapp-test",
  slackWebhookPath: "/slack/events",
  clientOptions: {},
} as const;

afterEach(() => vi.restoreAllMocks());

function expectNoSocketListeners(client: EventEmitter) {
  for (const event of ["disconnected", "unable_to_socket_mode_start", "error"]) {
    expect(client.listenerCount(event)).toBe(0);
  }
}

async function createSocketApp(clientOptions: Record<string, unknown> = {}) {
  const slackBoltModule = await import("@slack/bolt");
  const interop = resolveSlackBoltInterop(slackBoltModule);
  const result = createSlackBoltApp({ ...socketOptions, interop, clientOptions });
  if (!(result.receiver instanceof interop.SocketModeReceiver)) {
    throw new Error("expected a Socket Mode receiver");
  }
  return { ...result, receiver: result.receiver };
}

async function createSocketServer() {
  const socketServer = new WebSocketServer({ port: 0 });
  const acknowledgements: string[] = [];
  const connectionSizes: number[] = [];
  socketServer.on("connection", (socket) => {
    connectionSizes.push(socketServer.clients.size);
    socket.on("message", (data) => {
      acknowledgements.push(JSON.parse(rawDataToString(data)).envelope_id);
    });
    socket.send(JSON.stringify({ type: "hello", num_connections: socketServer.clients.size }));
  });
  await new Promise<void>((resolve) => {
    socketServer.once("listening", resolve);
  });
  const address = socketServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP Socket Mode test server");
  }
  const result = await createSocketApp({
    fetch: async () => Response.json({ ok: true, url: `ws://127.0.0.1:${address.port}` }),
  });
  return { ...result, socketServer, acknowledgements, connectionSizes };
}

async function stopSocketServer({
  app,
  receiver,
  socketServer,
}: Awaited<ReturnType<typeof createSocketServer>>) {
  // Bolt stop resolves before the SDK's close handshake and timer cleanup.
  const disconnected = new Promise<void>((resolve) => {
    receiver.client.once("disconnected", resolve);
  });
  await Promise.all([gracefulStopSlackApp(app, receiver.client), disconnected]);
  for (const socket of socketServer.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    socketServer.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("createSlackBoltApp", () => {
  class FakeApp {
    middleware: unknown[] = [];
    constructor(readonly args: Record<string, unknown>) {}

    use(middleware: unknown) {
      this.middleware.push(middleware);
    }
  }

  class FakeHTTPReceiver {
    constructor(readonly args: Record<string, unknown>) {}
  }

  function createSocketClient() {
    return Object.assign(new EventEmitter(), {
      clientPingTimeoutMS: 0,
      numOfConsecutiveReconnectionFailures: 0,
      shuttingDown: false,
      send: async () => {},
      start: vi.fn(async () => {}),
      delayReconnectAttempt: (_callback: () => Promise<unknown>): Promise<unknown> => {
        throw new Error("native reconnect observer was not installed");
      },
    });
  }
  class FakeSocketModeReceiver extends FakeHTTPReceiver {
    client = createSocketClient();
  }

  const fakeInterop = {
    App: FakeApp as never,
    HTTPReceiver: FakeHTTPReceiver as never,
    SocketModeReceiver: FakeSocketModeReceiver as never,
  };

  it("resolves the App constructor with namespace receivers", () => {
    const { App, HTTPReceiver, SocketModeReceiver } = fakeInterop;
    expect(resolveSlackBoltInterop({ default: App, HTTPReceiver, SocketModeReceiver })).toEqual(
      fakeInterop,
    );
  });

  function createFakeApp(overrides: Partial<Parameters<typeof createSlackBoltApp>[0]> = {}) {
    const result = createSlackBoltApp({ ...socketOptions, interop: fakeInterop, ...overrides });
    return {
      ...result,
      app: result.app as unknown as FakeApp,
      receiver: result.receiver as unknown as FakeHTTPReceiver | FakeSocketModeReceiver,
    };
  }

  it("filters Socket Mode noise through the configured receiver logger", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { receiver, socketModeLogger } = createFakeApp();
    expect(receiver.args.logger).toBe(socketModeLogger);
    socketModeLogger.setName("SlackWebSocket:1");
    for (const message of [
      "A pong wasn't received from the server before the timeout of 15000ms!",
      "A ping wasn't received from the server before the timeout of 30000ms!",
      "The logLevel given to Socket Mode was ignored as you also gave logger",
      "Received unexpected ping diagnostics message format",
      "Received unexpected pong diagnostics message format",
    ]) {
      socketModeLogger.warn(message);
    }
    socketModeLogger.warn("another socket warning");
    expect(warn.mock.calls).toEqual([["socket-mode:SlackWebSocket:1", "another socket warning"]]);
  });

  it("applies OpenClaw self-event filtering through installed Bolt middleware", async () => {
    const { app } = createFakeApp();
    const middleware = app.middleware[0] as
      | ((args: {
          next: () => Promise<void>;
          context?: { botId?: string; botUserId?: string };
          event?: unknown;
          message?: unknown;
        }) => Promise<void>)
      | undefined;
    if (!middleware) {
      throw new Error("expected Slack self-event middleware");
    }

    const bot = { botUserId: "U_BOT", botId: "B_BOT" };
    const cases = [
      [{ event: { type: "reaction_added", user: "U_BOT" } }, false],
      [{ event: { type: "message", subtype: "message_changed", user: "U_BOT" } }, true],
      [
        {
          event: { type: "message", user: "U_OTHER" },
          message: { subtype: "bot_message", bot_id: "B_BOT" },
        },
        false,
      ],
    ] as const;

    for (const [args, forwarded] of cases) {
      const next = vi.fn(async () => {});
      await middleware({ ...args, context: bot, next });
      expect(next).toHaveBeenCalledTimes(forwarded ? 1 : 0);
    }
  });

  it("routes native reconnect start failures through the socket disconnect event", async () => {
    const startError = new Error("invalid_auth");
    const { receiver } = createFakeApp();
    if (!(receiver instanceof FakeSocketModeReceiver)) {
      throw new Error("expected Socket Mode receiver");
    }
    const client = receiver.client;
    client.start.mockRejectedValue(startError);
    const emit = vi.spyOn(client, "emit");

    await expect(client.delayReconnectAttempt(client.start)).resolves.toBeUndefined();
    await expect(
      client.delayReconnectAttempt(async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");
    expect(emit.mock.calls).toEqual([
      ["reconnecting"],
      ["unable_to_socket_mode_start", startError],
      ["reconnecting"],
    ]);
  });

  it("cancels a pending native reconnect when the app is stopped and started again", async () => {
    vi.useFakeTimers();
    try {
      const { app, receiver } = await createSocketApp();
      const client = receiver.client;
      const stop = app.stop.bind(app);
      vi.spyOn(app, "stop").mockImplementation(async () => {
        expect(Reflect.get(client, "shuttingDown")).toBe(true);
        await stop();
      });
      const start = vi.fn(async () => {
        Reflect.set(client, "shuttingDown", false);
      });
      Reflect.set(client, "start", start);
      const delayReconnectAttempt = Reflect.get(client, "delayReconnectAttempt");
      if (typeof delayReconnectAttempt !== "function") {
        throw new Error("expected a native reconnect scheduler");
      }

      void delayReconnectAttempt.call(client, start);
      await gracefulStopSlackApp(app, client);
      await app.start();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(start).toHaveBeenCalledTimes(1);
      await gracefulStopSlackApp(app, client);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a transient error and close through one real SDK socket lifecycle", async () => {
    const fixture = await createSocketServer();
    const { app, receiver, socketServer, connectionSizes } = fixture;

    const client = receiver.client;
    Reflect.set(client, "clientPingTimeoutMS", 20);
    const appStart = vi.spyOn(app, "start");
    const abortController = new AbortController();
    const lifecycle = startSlackSocketAndWaitForDisconnect({
      app,
      socketClient: client,
      abortSignal: abortController.signal,
    });
    let lifecycleSettled = false;
    const lifecycleOutcome = lifecycle.then((value) => {
      lifecycleSettled = true;
      return value;
    });

    try {
      await vi.waitFor(() => expect(socketServer.clients.size).toBe(1));
      client.emit("error", new Error("transient transport error"));
      for (const socket of socketServer.clients) {
        socket.terminate();
      }
      await vi.waitFor(() => expect(connectionSizes).toHaveLength(2));
      await vi.waitFor(() => expect(socketServer.clients.size).toBe(1));

      expect(appStart).toHaveBeenCalledTimes(1);
      expect(Math.max(...connectionSizes)).toBe(1);
      expect(lifecycleSettled).toBe(false);
    } finally {
      abortController.abort();
      await lifecycleOutcome;
      await stopSocketServer(fixture);
    }
  });

  it.each([
    { type: "app_rate_limited", team_id: "T1", minute_rate_limited: 123, api_app_id: "A1" },
    { type: "event_callback" },
  ])(
    "acknowledges control or incomplete envelopes and keeps receiving messages: $type",
    async (body) => {
      const fixture = await createSocketServer();
      const { app, socketServer, socketModeLogger, acknowledgements } = fixture;
      const processEvent = vi.spyOn(app, "processEvent").mockImplementation(async (event) => {
        await event.ack();
      });
      const warning = vi.spyOn(socketModeLogger, "warn");
      try {
        await app.start();
        for (const socket of socketServer.clients) {
          const send = (envelope_id: string, payload: object) =>
            socket.send(JSON.stringify({ type: "events_api", envelope_id, payload }));
          send("control", body);
          send("message", {
            type: "event_callback",
            event: { type: "message", text: "still connected" },
          });
        }
        await vi.waitFor(() => expect(acknowledgements).toEqual(["control", "message"]));
        expect(processEvent).toHaveBeenCalledTimes(1);
        expect(processEvent.mock.calls[0]?.[0].body).toMatchObject({
          event: { text: "still connected" },
        });
        expect(warning).toHaveBeenCalledTimes(1);
        expect(socketServer.clients.size).toBe(1);
      } finally {
        await stopSocketServer(fixture);
      }
    },
  );

  it.each(["socket", "http"] as const)(
    "routes %s Events API receive through the durable receiver wrapper",
    async (slackMode) => {
      const wrappedReceiver = { durable: true };
      const wrapReceiver = vi.fn(() => wrappedReceiver as never);
      const { app, receiver } = createFakeApp({
        slackMode,
        signingSecret: "test-signing-secret",
        wrapReceiver,
      });

      expect(wrapReceiver).toHaveBeenCalledWith(receiver);
      expect(app.args).toMatchObject({
        receiver: wrappedReceiver,
        tokenVerificationEnabled: false,
      });
      await expect(
        (receiver.args.processEventErrorHandler as () => Promise<boolean>)(),
      ).resolves.toBe(false);
    },
  );
});

describe("slack socket reconnect helpers", () => {
  it("marks socket mode disconnected without error when the socket closes cleanly", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_402_000);

    publishSlackDisconnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledExactlyOnceWith({
      connected: false,
      lifecycle: "recovering",
      lastDisconnect: { at: 1_711_406_402_000 },
      lastError: null,
    });
  });

  it("warns once when Slack reports a shared Socket Mode app token", () => {
    const client = new EventEmitter();
    const onSharedConnection = vi.fn();
    const unregister = registerSlackSocketModeConnectionDiagnostics({
      client,
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

    expect(onSharedConnection.mock.calls).toEqual([[2]]);
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
      start: vi.fn().mockImplementation(async () => {
        client.emit("disconnected");
      }),
    };
    const onStarted = vi.fn();

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app,
        socketClient: client,
        onStarted,
      }),
    ).resolves.toEqual({ event: "disconnect" });

    expect(app.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["onStarted", "status sink failed"],
    ["start", "missing_scope"],
  ] as const)("cleans up %s failure and preserves its error detail", async (phase, message) => {
    const client = new EventEmitter();
    const err = new Error(message);
    const app = {
      start: vi.fn(async () => {
        if (phase === "start") {
          client.emit("unable_to_socket_mode_start", err);
          throw new Error();
        }
      }),
    };
    await expect(
      startSlackSocketAndWaitForDisconnect({
        app,
        socketClient: client,
        onStarted:
          phase === "onStarted"
            ? () => {
                throw err;
              }
            : undefined,
      }),
    ).rejects.toThrow(message);
    expectNoSocketListeners(client);
  });
});

it("does not treat missing or non-error values as permanent auth failures", () => {
  for (const value of [null, undefined, 42, {}]) {
    expect(isNonRecoverableSlackAuthError(value)).toBe(false);
  }
});
