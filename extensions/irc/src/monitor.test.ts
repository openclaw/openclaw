// Irc tests cover monitor plugin behavior.
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createIrcIngressMonitor } from "./irc-ingress.js";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";
import { monitorIrcProvider } from "./monitor.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

type DisconnectingIrcServer = {
  port: number;
  lines: string[];
  connectionCount: number;
  joined: Promise<void>;
  rejoined: Promise<void>;
  disconnectFirst(): void;
  close(): Promise<void>;
};

type InboundIrcServer = {
  port: number;
  lines: string[];
  sendInbound(target: string, colonlessBody?: boolean, senderNick?: string): void;
  sendNotice(target: string, text: string): void;
  close(): Promise<void>;
};

type ReconnectingReplyIrcServer = {
  port: number;
  linesByConnection: string[][];
  replacementQuitReceived: Promise<void>;
  connectionCount: number;
  sendInbound(): void;
  disconnectFirst(): void;
  close(): Promise<void>;
};

type IrcIngressQueue = NonNullable<Parameters<typeof createIrcIngressMonitor>[0]["queue"]>;
type IrcIngressPayload = Parameters<IrcIngressQueue["enqueue"]>[1];
type IrcMonitorMessageHandler = NonNullable<Parameters<typeof monitorIrcProvider>[0]["onMessage"]>;

async function withIngressQueue<T>(
  fn: (queue: IrcIngressQueue, stateDir: string) => Promise<T>,
  accountId = "default",
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-irc-monitor-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<IrcIngressPayload>({
    channelId: "irc",
    accountId,
    stateDir,
  });
  const complete = queue.complete.bind(queue);
  try {
    return await fn(queue, stateDir);
  } finally {
    queue.complete = complete;
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function observeIngressCompletion(queue: IrcIngressQueue): Promise<string> {
  const completed = createDeferred<string>();
  const complete = queue.complete.bind(queue);
  // An empty pending list also hides active claims; observe the real terminal write.
  queue.complete = async (idOrClaim, ...args) => {
    const result = await complete(idOrClaim, ...args);
    if (result) {
      completed.resolve(typeof idOrClaim === "string" ? idOrClaim : idOrClaim.id);
    }
    return result;
  };
  return completed.promise;
}

function observeReconnect() {
  const reconnected = createDeferred<void>();
  let readyCount = 0;
  const statusSink = vi.fn<NonNullable<Parameters<typeof monitorIrcProvider>[0]["statusSink"]>>(
    (patch) => {
      if (patch.lifecycle === "ready" && ++readyCount === 2) {
        reconnected.resolve();
      }
    },
  );
  return { statusSink, reconnected: reconnected.promise };
}

async function startDisconnectingIrcServer(loginError?: string): Promise<DisconnectingIrcServer> {
  const lines: string[] = [];
  const joined = createDeferred<void>();
  const rejoined = createDeferred<void>();
  let connectionCount = 0;
  let firstSocket: net.Socket;
  const server = await startIrcTestServer((socket) => {
    const connectionNumber = ++connectionCount;
    if (connectionNumber === 1) {
      firstSocket = socket;
    }
    onIrcTestLine(socket, (line) => {
      lines.push(line);
      if (line === "JOIN #openclaw") {
        (connectionNumber === 1 ? joined : rejoined).resolve();
      }
      if (line.startsWith("USER ")) {
        if (connectionNumber === 2) {
          if (loginError) {
            socket.write(`:server ${loginError} bot :login rejected\r\n`);
          } else {
            socket.destroy();
          }
        } else {
          socket.write(":server 001 bot :welcome\r\n");
        }
      }
    });
  });
  return {
    ...server,
    lines,
    joined: joined.promise,
    rejoined: rejoined.promise,
    disconnectFirst: () => firstSocket.destroy(),
    get connectionCount() {
      return connectionCount;
    },
  };
}

async function startInboundIrcServer(welcomeNick = "bot"): Promise<InboundIrcServer> {
  let clientSocket: net.Socket;
  const lines: string[] = [];
  const server = await startIrcTestServer((socket) => {
    clientSocket = socket;
    onIrcTestLine(socket, (line) => {
      lines.push(line);
      if (line.startsWith("USER ")) {
        socket.write(`:server 001 ${welcomeNick} :welcome\r\n`);
      }
    });
  });
  return {
    ...server,
    lines,
    sendInbound: (target, colonlessBody = false, senderNick = "alice") => {
      const bodySeparator = colonlessBody ? " " : " :";
      clientSocket.write(
        `:${senderNick}!ident@example.org PRIVMSG ${target}${bodySeparator}hello\r\n`,
      );
    },
    sendNotice: (target, text) => {
      clientSocket.write(`:server NOTICE ${target} :${text}\r\n`);
    },
  };
}

async function startReconnectingReplyIrcServer(): Promise<ReconnectingReplyIrcServer> {
  // Retain closed sockets in order so reconnect assertions keep their original connection index.
  const sockets: net.Socket[] = [];
  const linesByConnection: string[][] = [];
  const replacementQuitReceived = createDeferred<void>();
  const server = await startIrcTestServer((socket) => {
    const connectionIndex = sockets.length;
    sockets.push(socket);
    linesByConnection[connectionIndex] = [];
    onIrcTestLine(socket, (line) => {
      linesByConnection[connectionIndex]?.push(line);
      if (connectionIndex === 1 && line.startsWith("QUIT :")) {
        replacementQuitReceived.resolve();
      }
      if (line.startsWith("USER ")) {
        const nick = connectionIndex === 0 ? "receipt-bot" : "reconnected-bot";
        socket.write(`:server 001 ${nick} :welcome\r\n`);
      }
    });
  });
  return {
    ...server,
    linesByConnection,
    replacementQuitReceived: replacementQuitReceived.promise,
    sendInbound: () => sockets[0]!.write(":alice!ident@example.org PRIVMSG receipt-bot :hello\r\n"),
    get connectionCount() {
      return sockets.length;
    },
    disconnectFirst: () => sockets[0]?.destroy(),
  };
}

function monitorConfig(
  port: number,
  nick = "bot",
  extra: Partial<NonNullable<NonNullable<CoreConfig["channels"]>["irc"]>> = {},
): CoreConfig {
  return {
    channels: {
      irc: {
        host: "127.0.0.1",
        port,
        tls: false,
        nick,
        username: "bot",
        realname: "OpenClaw",
        ...extra,
      },
    },
  };
}

function installMonitorRuntime(debug = vi.fn(), verbose = false) {
  const activityRecord = vi.fn();
  setIrcRuntime({
    logging: {
      shouldLogVerbose: vi.fn(() => verbose),
      getChildLogger: vi.fn(() => ({
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
    channel: {
      activity: {
        record: activityRecord,
      },
    },
  } as never);
  return activityRecord;
}

function installPairingMonitorRuntime(
  upsertPairingRequest: () => Promise<{ code: string; created: boolean }>,
) {
  setIrcRuntime(
    createPluginRuntimeMock({
      channel: {
        activity: { record: vi.fn() },
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(upsertPairingRequest),
        },
        commands: { shouldHandleTextCommands: vi.fn(() => false) },
        text: { hasControlCommand: vi.fn(() => false) },
        mentions: {
          buildMentionRegexes: vi.fn(() => []),
          matchesMentionPatterns: vi.fn(() => false),
        },
      },
    }),
  );
}

describe("IRC automatic reply outcomes", () => {
  it("reports sanitized-empty replies without recording outbound delivery", async ({ signal }) => {
    await withIngressQueue(async (ingressQueue) => {
      const completed = observeIngressCompletion(ingressQueue);
      const core = createPluginRuntimeMock();
      vi.mocked(core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
        async ({ dispatcherOptions }) => {
          try {
            await dispatcherOptions.deliver({ text: "\u0001" }, { kind: "final" });
          } catch (error) {
            await dispatcherOptions.onError?.(error, { kind: "final" });
          }
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      );
      setIrcRuntime(core);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const statusSink = vi.fn();
      const server = await startInboundIrcServer();
      let monitor: Awaited<ReturnType<typeof monitorIrcProvider>> | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: {
            channels: {
              irc: {
                host: "127.0.0.1",
                port: server.port,
                tls: false,
                nick: "bot",
                dmPolicy: "open",
                allowFrom: ["*"],
              },
            },
          },
          ingressQueue,
          runtime,
          statusSink,
        });
        server.sendInbound("bot");
        await withinTest(completed, signal);

        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Message must be non-empty for IRC sends"),
        );
        expect(server.lines.some((line) => line.startsWith("PRIVMSG "))).toBe(false);
        expect(statusSink.mock.calls.some(([patch]) => patch.lastOutboundAt)).toBe(false);
        expect(core.channel.activity.record).not.toHaveBeenCalledWith(
          expect.objectContaining({ direction: "outbound" }),
        );
      } finally {
        await monitor?.stop();
        await server.close();
      }
    });
  });
});

describe("IRC configured-unavailable credential connection boundaries", () => {
  it("opens no connection when an active NickServ SecretRef is unavailable", async () => {
    installMonitorRuntime();
    const connectSpy = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("unexpected IRC connection");
    });
    const config = {
      channels: {
        irc: {
          host: "127.0.0.1",
          port: 6667,
          tls: false,
          nick: "openclaw",
          nickserv: {
            password: { source: "env", provider: "default", id: "IRC_UNAVAILABLE_EXPLICIT_SECRET" },
          },
        },
      },
    } as unknown as CoreConfig;

    try {
      await withIngressQueue(async (ingressQueue) => {
        await expect(monitorIrcProvider({ config, ingressQueue })).rejects.toThrow(
          /configured but unavailable/i,
        );
      });
      expect(connectSpy).not.toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
    }
  });
});

describe("irc monitor reconnect", () => {
  it("settles only the stopped account's admission and recovers its durable message on a fresh socket", async ({
    signal,
  }) => {
    installMonitorRuntime();
    await withIngressQueue(async (alphaQueue, stateDir) => {
      const betaQueue = createChannelIngressQueueForTests<IrcIngressPayload>({
        channelId: "irc",
        accountId: "beta",
        stateDir,
      });
      const sockets = new Map<string, net.Socket>();
      let connections = 0;
      const server = await startIrcTestServer((socket) => {
        connections += 1;
        let nick = "";
        onIrcTestLine(socket, (line) => {
          if (line.startsWith("NICK ")) {
            nick = line.slice(5);
            sockets.set(nick, socket);
          }
          if (line.startsWith("USER ")) {
            socket.write(`:server 001 ${nick} :welcome\r\n`);
          }
        });
      });
      const config: CoreConfig = {
        channels: {
          irc: {
            host: "127.0.0.1",
            port: server.port,
            tls: false,
            accounts: { alpha: { nick: "qa-alpha" }, beta: { nick: "qa-beta" } },
          },
        },
      };
      const alphaDispatch = vi.fn<IrcMonitorMessageHandler>();
      const betaDispatch = vi.fn<IrcMonitorMessageHandler>();
      const freshDispatch = vi.fn<IrcMonitorMessageHandler>();
      const stored = createDeferred<void>();
      const releaseAdmission = createDeferred<void>();
      const enqueue = alphaQueue.enqueue.bind(alphaQueue);
      alphaQueue.enqueue = async (...args) => {
        const result = await enqueue(...args);
        stored.resolve();
        await releaseAdmission.promise;
        return result;
      };
      const monitors: Array<{ stop: () => Promise<void> }> = [];
      const start = async (
        accountId: string,
        ingressQueue: IrcIngressQueue,
        onMessage: IrcMonitorMessageHandler,
      ) => {
        const monitor = await monitorIrcProvider({ accountId, config, ingressQueue, onMessage });
        monitors.push(monitor);
        return monitor;
      };
      try {
        const alpha = await start("alpha", alphaQueue, alphaDispatch);
        await start("beta", betaQueue, betaDispatch);
        const betaSocket = sockets.get("qa-beta");
        expect(betaSocket).toBeDefined();
        sockets.get("qa-alpha")?.write(":alice!ident@example.org PRIVMSG #alpha :recover me\r\n");
        await withinTest(stored.promise, signal);
        let stopSettled = false;
        const stopping = alpha.stop().then(() => {
          stopSettled = true;
        });
        const betaCompleted = observeIngressCompletion(betaQueue);
        betaSocket?.write(":bob!ident@example.org PRIVMSG #beta :sibling stays live\r\n");
        await withinTest(betaCompleted, signal);
        expect(stopSettled).toBe(false);
        expect(betaDispatch).toHaveBeenCalledOnce();
        expect(alphaDispatch).not.toHaveBeenCalled();

        releaseAdmission.resolve();
        await stopping;
        alphaQueue.enqueue = enqueue;
        const pending = await alphaQueue.listPending({ limit: "all" });
        expect(pending).toHaveLength(1);
        const recovered = observeIngressCompletion(alphaQueue);
        await start("alpha", alphaQueue, freshDispatch);
        expect(await withinTest(recovered, signal)).toBe(pending[0]?.id);
        expect(freshDispatch).toHaveBeenCalledOnce();
        expect(freshDispatch.mock.calls[0]?.[0]).toMatchObject({
          text: "recover me",
          target: "#alpha",
        });
        expect(await alphaQueue.listPending({ limit: "all" })).toEqual([]);
        expect(sockets.get("qa-beta")).toBe(betaSocket);
        expect(betaSocket?.destroyed).toBe(false);
        expect(connections).toBe(3);
      } finally {
        releaseAdmission.resolve();
        alphaQueue.enqueue = enqueue;
        await Promise.all(monitors.map((monitor) => monitor.stop()));
        await server.close();
      }
    }, "alpha");
  });

  it.for([
    {
      failure: "a closed socket",
      silent: false,
      loginError: undefined,
      error: "closed before ready",
    },
    { failure: "a rejected login", silent: false, loginError: "464", error: "login failed (464)" },
    {
      failure: "a silent socket",
      silent: true,
      loginError: undefined,
      error: "closed before ready",
    },
  ])(
    "reports disconnected status and recovers after $failure",
    async ({ loginError, error, silent }, { signal }) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      await withIngressQueue(async (ingressQueue) => {
        installMonitorRuntime();
        const disconnected = createDeferred<void>();
        const failedReconnect = createDeferred<void>();
        const reconnected = createDeferred<void>();
        let readyCount = 0;
        let recoveringCount = 0;
        const status: Parameters<
          NonNullable<Parameters<typeof monitorIrcProvider>[0]["statusSink"]>
        >[0] = {};
        const statusSink: NonNullable<Parameters<typeof monitorIrcProvider>[0]["statusSink"]> = (
          patch,
        ) => {
          Object.assign(status, patch);
          if (patch.lifecycle === "ready" && ++readyCount === 2) {
            reconnected.resolve();
          }
          if (patch.lifecycle === "recovering") {
            recoveringCount += 1;
            (recoveringCount === 1 ? disconnected : failedReconnect).resolve();
          }
        };
        const server = await startDisconnectingIrcServer(loginError);
        const config = monitorConfig(server.port, "bot", { channels: ["#openclaw"] });
        let monitor: { stop: () => Promise<void> } | undefined;

        try {
          monitor = await monitorIrcProvider({ config, ingressQueue, statusSink });
          await withinTest(server.joined, signal);
          if (silent) {
            await vi.advanceTimersByTimeAsync(240_000);
          } else {
            server.disconnectFirst();
          }
          await withinTest(disconnected.promise, signal);
          expect(status).toMatchObject({
            running: true,
            connected: false,
            lifecycle: "recovering",
            lastDisconnect: { at: expect.any(Number) },
          });
          const disconnectedAt = status.lastDisconnect;
          await vi.advanceTimersByTimeAsync(1_200);
          await withinTest(failedReconnect.promise, signal);
          expect(status).toMatchObject({
            running: true,
            connected: false,
            lifecycle: "recovering",
            lastError: expect.stringContaining(error),
            lastDisconnect: disconnectedAt,
          });
          await vi.advanceTimersByTimeAsync(2_400);
          await withinTest(reconnected.promise, signal);
          await withinTest(server.rejoined, signal);
          expect(status).toMatchObject({ running: true, connected: true, lastError: null });
          expect(server.connectionCount).toBe(3);
          expect(server.lines.filter((line) => line === "JOIN #openclaw")).toHaveLength(2);
          await monitor.stop();
          await vi.advanceTimersByTimeAsync(240_000);
          expect(server.connectionCount).toBe(3);
        } finally {
          if (monitor) {
            await monitor.stop();
          }
          await server.close();
        }
      });
    },
  );

  it("does not send a delayed private reply through the reconnected client", async () => {
    await withIngressQueue(async (ingressQueue) => {
      const pairingStarted = createDeferred<void>();
      const pairingResult = createDeferred<{ code: string; created: boolean }>();
      const completed = observeIngressCompletion(ingressQueue);
      const { statusSink, reconnected } = observeReconnect();
      installPairingMonitorRuntime(async () => {
        pairingStarted.resolve();
        return await pairingResult.promise;
      });
      const server = await startReconnectingReplyIrcServer();
      const enqueueSpy = vi.spyOn(ingressQueue, "enqueue");
      let monitor: { stop: () => Promise<void> } | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: monitorConfig(server.port, "receipt-bot", { dmPolicy: "pairing" }),
          ingressQueue,
          statusSink,
        });
        server.sendInbound();
        await withTimeout(pairingStarted.promise, 3000, "IRC pairing started");
        server.disconnectFirst();
        await withTimeout(reconnected, 3000, "IRC replacement connection ready");
        expect(server.connectionCount).toBeGreaterThanOrEqual(2);
        expect(server.linesByConnection[1]?.some((line) => line.startsWith("USER "))).toBe(true);
        pairingResult.resolve({ code: "CODE", created: true });
        const completedId = await withTimeout(completed, 3000, "stale private reply completion");
        expect(enqueueSpy).toHaveBeenCalledOnce();
        expect(completedId).toBe(enqueueSpy.mock.calls[0]?.[0]);
        expect(await ingressQueue.listPending({ limit: "all" })).toEqual([]);
        expect(await ingressQueue.listClaims()).toEqual([]);
        // Let the delayed send finish before shutdown can suppress it.
        // Peer-observed QUIT follows any reply bytes queued on the replacement socket.
        await monitor.stop();
        await withTimeout(server.replacementQuitReceived, 3000, "replacement IRC QUIT");
        expect(
          server.linesByConnection[0]?.some((line) => line.startsWith("PRIVMSG alice :")),
        ).toBe(false);
        expect(
          server.linesByConnection[1]?.some((line) => line.startsWith("PRIVMSG alice :")),
        ).toBe(false);
      } finally {
        pairingResult.resolve({ code: "CODE", created: true });
        if (monitor) {
          await monitor.stop();
        }
        enqueueSpy.mockRestore();
        await server.close();
      }
    });
  });
});

describe("irc monitor inbound target", () => {
  it.each([
    {
      label: "channel",
      serverTarget: "#openclaw",
      expected: { isGroup: true, target: "#openclaw", rawTarget: "#openclaw" },
    },
    {
      label: "DM",
      serverTarget: "openclaw-bot",
      expected: { isGroup: false, target: "alice", rawTarget: "openclaw-bot" },
    },
    {
      label: "channel with a colonless body",
      serverTarget: "#openclaw",
      colonlessBody: true,
      expected: { isGroup: true, target: "#openclaw", rawTarget: "#openclaw" },
    },
  ])(
    "maps $label targets through the monitor boundary",
    async ({ serverTarget, colonlessBody, expected }) => {
      await withIngressQueue(async (ingressQueue) => {
        const debug = vi.fn();
        installMonitorRuntime(debug, true);
        const server = await startInboundIrcServer();
        const noticeText = "private-notice-sentinel";
        const messages: IrcInboundMessage[] = [];
        const completed = observeIngressCompletion(ingressQueue);
        let monitor: { stop: () => Promise<void> } | undefined;
        try {
          monitor = await monitorIrcProvider({
            config: monitorConfig(server.port),
            ingressQueue,
            onMessage: (message) => {
              messages.push(message);
            },
          });
          server.sendNotice(serverTarget, noticeText);
          server.sendInbound(serverTarget, colonlessBody);
          const completedId = await withTimeout(completed, 3000, "inbound IRC message completion");
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({
            messageId: completedId,
            ...expected,
            senderNick: "alice",
            text: "hello",
          });
          expect(debug).toHaveBeenCalledWith(expect.stringContaining(`notice ${serverTarget}`));
          const diagnostics = JSON.stringify(debug.mock.calls);
          expect(diagnostics).not.toContain("hello");
          expect(diagnostics).not.toContain(noticeText);
        } finally {
          if (monitor) {
            await monitor.stop();
          }
          await server.close();
        }
      });
    },
  );

  it("uses the receipt-time nickname when replaying a self echo", async () => {
    await withIngressQueue(async (ingressQueue) => {
      installMonitorRuntime();
      const eventId = "local:previous-connection:000000000001";
      const receivedAt = Date.now();
      await ingressQueue.enqueue(
        eventId,
        {
          version: 1,
          eventId,
          receivedAt,
          connectionEpoch: "previous-connection",
          connectedNick: "receipt-bot",
          rawLine: ":receipt-bot!ident@example.org PRIVMSG #openclaw :echo",
        },
        { receivedAt, laneKey: "channel:#openclaw" },
      );
      const server = await startInboundIrcServer("reconnected-bot");
      const onMessage = vi.fn();
      const completed = observeIngressCompletion(ingressQueue);
      let monitor: { stop: () => Promise<void> } | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: monitorConfig(server.port, "reconnected-bot"),
          ingressQueue,
          onMessage,
        });
        expect(await withTimeout(completed, 3000, "replayed self echo completion")).toBe(eventId);
        expect(await ingressQueue.listPending({ limit: "all" })).toEqual([]);
        expect(await ingressQueue.listClaims()).toEqual([]);
        expect(onMessage).not.toHaveBeenCalled();
      } finally {
        if (monitor) {
          await monitor.stop();
        }
        await server.close();
      }
    });
  });

  it("does not replay a DM after the accepting connection changed", async () => {
    await withIngressQueue(async (ingressQueue) => {
      installMonitorRuntime();
      const eventId = "local:previous-connection:000000000002";
      const receivedAt = Date.now();
      await ingressQueue.enqueue(
        eventId,
        {
          version: 1,
          eventId,
          receivedAt,
          connectionEpoch: "previous-connection",
          connectedNick: "receipt-bot",
          rawLine: ":alice!ident@example.org PRIVMSG receipt-bot :private",
        },
        { receivedAt, laneKey: "direct:alice" },
      );
      const server = await startInboundIrcServer("receipt-bot");
      const onMessage = vi.fn();
      const completed = observeIngressCompletion(ingressQueue);
      let monitor: { stop: () => Promise<void> } | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: monitorConfig(server.port, "receipt-bot"),
          ingressQueue,
          onMessage,
        });
        expect(await withTimeout(completed, 3000, "replayed DM completion")).toBe(eventId);
        expect(await ingressQueue.listPending({ limit: "all" })).toEqual([]);
        expect(await ingressQueue.listClaims()).toEqual([]);
        expect(onMessage).not.toHaveBeenCalled();
      } finally {
        if (monitor) {
          await monitor.stop();
        }
        await server.close();
      }
    });
  });

  it("does not record receipt-time self echoes as inbound activity", async () => {
    await withIngressQueue(async (ingressQueue) => {
      const activityRecord = installMonitorRuntime();
      const server = await startInboundIrcServer();
      const enqueueSpy = vi.spyOn(ingressQueue, "enqueue");
      const onMessage = vi.fn();
      const completed = observeIngressCompletion(ingressQueue);
      let monitor: { stop: () => Promise<void> } | undefined;
      try {
        monitor = await monitorIrcProvider({
          config: monitorConfig(server.port),
          ingressQueue,
          onMessage,
        });
        server.sendInbound("#openclaw", false, "bot");
        const completedId = await withTimeout(completed, 3000, "receipt-time self echo completion");
        expect(enqueueSpy).toHaveBeenCalledOnce();
        await enqueueSpy.mock.results[0]?.value;
        expect(completedId).toBe(enqueueSpy.mock.calls[0]?.[0]);
        expect(await ingressQueue.listPending({ limit: "all" })).toEqual([]);
        expect(await ingressQueue.listClaims()).toEqual([]);
        await monitor.stop();
        expect(onMessage).not.toHaveBeenCalled();
        expect(activityRecord).not.toHaveBeenCalled();
      } finally {
        if (monitor) {
          await monitor.stop();
        }
        enqueueSpy.mockRestore();
        await server.close();
      }
    });
  });
});
