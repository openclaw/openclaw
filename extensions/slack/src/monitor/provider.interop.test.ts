import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  createSlackBoltApp,
  gracefulStopSlackApp,
  resolveSlackBoltInterop,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";

const socketOptions = {
  slackMode: "socket",
  token: "xoxb-test",
  appToken: "xapp-test",
  slackWebhookPath: "/slack/events",
  clientOptions: {},
} as const;

async function createSocketApp(clientOptions: Record<string, unknown> = {}) {
  const slackBoltModule = await import("@slack/bolt");
  const interop = resolveSlackBoltInterop({
    defaultImport: slackBoltModule.default,
    namespaceImport: slackBoltModule,
  });
  const result = createSlackBoltApp({ ...socketOptions, interop, clientOptions });
  if (!(result.receiver instanceof interop.SocketModeReceiver)) {
    throw new Error("expected a Socket Mode receiver");
  }
  return { ...result, receiver: result.receiver };
}

async function createSocketServer() {
  const socketServer = new WebSocketServer({ port: 0 });
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
  return { ...result, socketServer };
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
  await Promise.all([gracefulStopSlackApp(app), disconnected]);
  for (const socket of socketServer.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    socketServer.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("resolveSlackBoltInterop", () => {
  function FakeApp() {}
  function FakeHTTPReceiver() {}
  function FakeSocketModeReceiver() {}

  const moduleExports = {
    App: FakeApp,
    HTTPReceiver: FakeHTTPReceiver,
    SocketModeReceiver: FakeSocketModeReceiver,
  };

  it.each([
    ["nested default import", { defaultImport: { default: moduleExports }, namespaceImport: {} }],
    [
      "App constructor with namespace receivers",
      {
        defaultImport: FakeApp,
        namespaceImport: {
          HTTPReceiver: FakeHTTPReceiver,
          SocketModeReceiver: FakeSocketModeReceiver,
        },
      },
    ],
    [
      "namespace default",
      { defaultImport: undefined, namespaceImport: { default: moduleExports } },
    ],
    ["namespace import", { defaultImport: undefined, namespaceImport: moduleExports }],
  ] as const)("resolves the %s module shape", (_name, imports) => {
    expect(resolveSlackBoltInterop(imports)).toEqual(moduleExports);
  });
});

describe("createSlackBoltApp", () => {
  class FakeApp {
    middleware: unknown[] = [];
    constructor(readonly args: Record<string, unknown>) {}

    use(middleware: unknown) {
      this.middleware.push(middleware);
      return this;
    }
  }

  class FakeHTTPReceiver {
    constructor(readonly args: Record<string, unknown>) {}
  }

  class FakeSocketModeReceiver extends FakeHTTPReceiver {
    client = Object.assign(new EventEmitter(), {
      send: vi.fn<(envelopeId: string) => Promise<void>>().mockResolvedValue(undefined),
    });
  }

  const fakeInterop = {
    App: FakeApp as never,
    HTTPReceiver: FakeHTTPReceiver as never,
    SocketModeReceiver: FakeSocketModeReceiver as never,
  };

  it("filters Socket Mode noise and retains SDK errors through the configured receiver logger", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { receiver, socketModeLogger } = createSlackBoltApp({
        ...socketOptions,
        interop: fakeInterop,
      });
      const receiverLogger = (receiver as unknown as FakeSocketModeReceiver).args.logger;
      expect(receiverLogger).toBe(socketModeLogger);

      socketModeLogger.setName("SlackWebSocket:1");
      socketModeLogger.warn(
        "A pong wasn't received from the server before the timeout of 15000ms!",
      );
      socketModeLogger.warn(
        "A ping wasn't received from the server before the timeout of 30000ms!",
      );
      socketModeLogger.warn(
        "The logLevel given to Socket Mode was ignored as you also gave logger",
      );
      socketModeLogger.warn("Received unexpected ping diagnostics message format");
      socketModeLogger.warn("Received unexpected pong diagnostics message format");
      socketModeLogger.warn("another socket warning");
      socketModeLogger.error("failed to retrieve WSS URL", {
        data: { error: "missing_scope", needed: "connections:write" },
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("socket-mode:SlackWebSocket:1", "another socket warning");
      expect(error).toHaveBeenCalledTimes(1);
      expect(socketModeLogger.getLastMessage()).toBe(
        "socket-mode:SlackWebSocket:1 failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("applies OpenClaw self-event filtering through installed Bolt middleware", async () => {
    const { app } = createSlackBoltApp({
      ...socketOptions,
      interop: fakeInterop,
    });
    const middleware = (app as unknown as FakeApp).middleware[0] as
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
      [{ context: bot, event: { type: "reaction_added", user: "U_BOT" } }, false],
      [
        { context: bot, event: { type: "message", subtype: "message_changed", user: "U_BOT" } },
        true,
      ],
      [
        {
          context: bot,
          event: { type: "message", user: "U_OTHER" },
          message: { subtype: "bot_message", bot_id: "B_BOT" },
        },
        false,
      ],
    ] as const;

    for (const [args, forwarded] of cases) {
      const next = vi.fn(async () => {});
      await middleware({ ...args, next });
      expect(next).toHaveBeenCalledTimes(forwarded ? 1 : 0);
    }
  });

  it("routes native reconnect start failures through the socket disconnect event", async () => {
    const startError = new Error("invalid_auth");
    class FakeSocketModeClient extends EventEmitter {
      emitted: unknown[][] = [];
      clientPingTimeoutMS = 0;
      numOfConsecutiveReconnectionFailures = 0;
      logger = { debug: () => undefined };
      shuttingDown = false;
      send = async () => {};
      start = async () => {
        throw startError;
      };

      delayReconnectAttempt(callback: (this: FakeSocketModeClient) => Promise<unknown>) {
        return Promise.resolve(callback.call(this));
      }

      override emit(event: string, ...args: unknown[]) {
        this.emitted.push([event, ...args]);
        return super.emit(event, ...args);
      }
    }
    class FakeObservedSocketModeReceiver {
      client = new FakeSocketModeClient();
    }
    const { receiver } = createSlackBoltApp({
      ...socketOptions,
      interop: {
        App: FakeApp as never,
        HTTPReceiver: FakeHTTPReceiver as never,
        SocketModeReceiver: FakeObservedSocketModeReceiver as never,
      },
    });

    const client = (receiver as unknown as FakeObservedSocketModeReceiver).client;

    await expect(client.delayReconnectAttempt(client.start)).resolves.toBeUndefined();
    await expect(
      client.delayReconnectAttempt(async () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow("transient");
    expect(client.emitted).toEqual([
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
      const start = vi.fn(async () => {
        Reflect.set(client, "shuttingDown", false);
      });
      Reflect.set(client, "start", start);
      const delayReconnectAttempt = Reflect.get(client, "delayReconnectAttempt");
      if (typeof delayReconnectAttempt !== "function") {
        throw new Error("expected a native reconnect scheduler");
      }

      void delayReconnectAttempt.call(client, start);
      await gracefulStopSlackApp(app);
      await app.start();
      await vi.advanceTimersByTimeAsync(15_000);

      expect(start).toHaveBeenCalledTimes(1);
      await gracefulStopSlackApp(app);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a transient error and close through one real SDK socket lifecycle", async () => {
    const fixture = await createSocketServer();
    const { app, receiver, socketServer } = fixture;
    let connectionAttempts = 0;
    let peakActiveConnections = 0;
    socketServer.on("connection", (socket) => {
      connectionAttempts += 1;
      peakActiveConnections = Math.max(peakActiveConnections, socketServer.clients.size);
      socket.send(JSON.stringify({ type: "hello", num_connections: socketServer.clients.size }));
    });

    const client = receiver.client;
    Reflect.set(client, "clientPingTimeoutMS", 20);
    const appStart = vi.spyOn(app, "start");
    const abortController = new AbortController();
    const lifecycle = startSlackSocketAndWaitForDisconnect({
      app,
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
      await vi.waitFor(() => expect(connectionAttempts).toBe(2));
      await vi.waitFor(() => expect(socketServer.clients.size).toBe(1));

      expect(appStart).toHaveBeenCalledTimes(1);
      expect(peakActiveConnections).toBe(1);
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
      const { app, socketServer, socketModeLogger } = fixture;
      const acknowledgements: string[] = [];
      socketServer.on("connection", (socket) => {
        socket.on("message", (data) => {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(new Uint8Array(data));
          acknowledgements.push(JSON.parse(bytes.toString("utf8")).envelope_id);
        });
        socket.send(JSON.stringify({ type: "hello" }));
      });
      const processEvent = vi.spyOn(app, "processEvent").mockImplementation(async (event) => {
        await event.ack();
      });
      const warning = vi.spyOn(socketModeLogger, "warn");
      try {
        await app.start();
        for (const socket of socketServer.clients) {
          socket.send(
            JSON.stringify({ type: "events_api", envelope_id: "control", payload: body }),
          );
          socket.send(
            JSON.stringify({
              type: "events_api",
              envelope_id: "message",
              payload: {
                type: "event_callback",
                event: { type: "message", text: "still connected" },
              },
            }),
          );
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
      const { app, receiver } = createSlackBoltApp({
        interop: fakeInterop,
        slackMode,
        token: "test-bot-token",
        ...(slackMode === "socket"
          ? { appToken: "test-app-token" }
          : { signingSecret: "test-signing-secret" }),
        slackWebhookPath: "/slack/events",
        clientOptions: {},
        wrapReceiver,
      });

      expect(wrapReceiver).toHaveBeenCalledWith(receiver);
      expect((app as unknown as FakeApp).args).toMatchObject({
        receiver: wrappedReceiver,
        tokenVerificationEnabled: false,
      });
      const receiverArgs = (receiver as unknown as FakeHTTPReceiver | FakeSocketModeReceiver).args;
      expect(receiverArgs.processEventErrorHandler).toBeTypeOf("function");
      await expect(
        (receiverArgs.processEventErrorHandler as () => Promise<boolean>)(),
      ).resolves.toBe(false);
    },
  );
});
