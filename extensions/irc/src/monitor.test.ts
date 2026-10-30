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
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";
import { monitorIrcProvider } from "./monitor.js";
import { getIrcRuntime, setIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

type IrcIngressQueue = ReturnType<typeof createChannelIngressQueueForTests>;

type IrcResources = {
  server: <T extends { close(): Promise<void> }>(pending: Promise<T>) => Promise<T>;
  monitor: typeof monitorIrcProvider;
  queue: (accountId: string) => IrcIngressQueue;
};

async function withIngressQueue<T>(
  fn: (queue: IrcIngressQueue, resources: IrcResources) => Promise<T>,
  accountId = "default",
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-irc-monitor-"));
  const stateDir = await fs.realpath(created);
  const queues = new Map<string, IrcIngressQueue>();
  const openQueue = (id: string) => {
    let queue = queues.get(id);
    if (!queue) {
      queue = createChannelIngressQueueForTests({ channelId: "irc", accountId: id, stateDir });
      queues.set(id, queue);
    }
    return queue;
  };
  const queue = openQueue(accountId);
  const complete = queue.complete.bind(queue);
  const cleanup: Array<() => Promise<void>> = [];
  const track = async <R>(pending: Promise<R>, dispose: (value: R) => Promise<void>) => {
    const value = await pending;
    cleanup.push(() => dispose(value));
    return value;
  };
  try {
    return await fn(queue, {
      server: (pending) => track(pending, (server) => server.close()),
      monitor: (options) => {
        vi.mocked(getIrcRuntime().state.openChannelIngressQueue).mockImplementation(
          ({ accountId: id = "default" } = {}) => openQueue(id),
        );
        return track(monitorIrcProvider(options), (monitor) => monitor.stop());
      },
      queue: openQueue,
    });
  } finally {
    for (const dispose of cleanup.toReversed()) {
      await dispose();
    }
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

async function startMonitorServer(
  options: {
    welcomeNick?: string;
    failSecond?: boolean;
    loginError?: string;
    renameOnReconnect?: boolean;
  } = {},
) {
  const sockets: net.Socket[] = [];
  const lines: string[] = [];
  const linesByConnection: string[][] = [];
  const joined = createDeferred<void>(),
    rejoined = createDeferred<void>();
  const replacementQuitReceived = createDeferred<void>();
  const server = await startIrcTestServer((socket) => {
    const index = sockets.length;
    sockets.push(socket);
    linesByConnection.push([]);
    onIrcTestLine(socket, (line) => {
      lines.push(line);
      linesByConnection[index]!.push(line);
      if (line === "JOIN #openclaw") {
        (index === 0 ? joined : rejoined).resolve();
      }
      if (index === 1 && line.startsWith("QUIT :")) {
        replacementQuitReceived.resolve();
      }
      if (!line.startsWith("USER ")) {
        return;
      }
      if (options.failSecond && index === 1) {
        if (options.loginError) {
          socket.write(`:server ${options.loginError} bot :login rejected\r\n`);
        } else {
          socket.destroy();
        }
      } else {
        const nick =
          options.renameOnReconnect && index > 0
            ? "reconnected-bot"
            : (options.welcomeNick ?? "bot");
        socket.write(`:server 001 ${nick} :welcome\r\n`);
      }
    });
  });
  return {
    ...server,
    lines,
    linesByConnection,
    joined: joined.promise,
    rejoined: rejoined.promise,
    replacementQuitReceived: replacementQuitReceived.promise,
    get connectionCount() {
      return sockets.length;
    },
    disconnectFirst: () => sockets[0]!.destroy(),
    sendInbound: (
      target = options.welcomeNick ?? "bot",
      colonlessBody = false,
      senderNick = "alice",
    ) => {
      sockets[0]!.write(
        `:${senderNick}!ident@example.org PRIVMSG ${target}${colonlessBody ? " " : " :"}hello\r\n`,
      );
    },
    sendNotice: (target: string, text: string) =>
      sockets[0]!.write(`:server NOTICE ${target} :${text}\r\n`),
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

const openInboundConfig = {
  dmPolicy: "open",
  allowFrom: ["*"],
  groupPolicy: "open",
  groups: { "*": { requireMention: false } },
} satisfies NonNullable<NonNullable<CoreConfig["channels"]>["irc"]>;

function installMonitorRuntime(debug = vi.fn(), verbose = false) {
  const core = createPluginRuntimeMock({
    logging: {
      shouldLogVerbose: vi.fn(() => verbose),
      getChildLogger: vi.fn(() => ({
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    },
  });
  vi.mocked(core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
    async ({ replyOptions }) => {
      // Let the real ingress lifecycle complete the claim at reply-lane adoption.
      await replyOptions?.turnAdoptionLifecycle?.onAdopted();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  );
  setIrcRuntime(core);
  return core;
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
    await withIngressQueue(async (ingressQueue, resources) => {
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
      const server = await resources.server(startMonitorServer());

      await resources.monitor({
        config: monitorConfig(server.port, "bot", { dmPolicy: "open", allowFrom: ["*"] }),
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
      await withIngressQueue(async (_queue, resources) => {
        await expect(resources.monitor({ config })).rejects.toThrow(/configured but unavailable/i);
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
    const core = installMonitorRuntime();
    const dispatch = vi.mocked(core.channel.reply.dispatchReplyWithBufferedBlockDispatcher);
    await withIngressQueue(async (alphaQueue, resources) => {
      const betaQueue = resources.queue("beta");
      const sockets = new Map<string, net.Socket>();
      let connections = 0;
      const server = await resources.server(
        startIrcTestServer((socket) => {
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
        }),
      );
      const config: CoreConfig = {
        channels: {
          irc: {
            ...openInboundConfig,
            host: "127.0.0.1",
            port: server.port,
            tls: false,
            accounts: { alpha: { nick: "qa-alpha" }, beta: { nick: "qa-beta" } },
          },
        },
      };
      const stored = createDeferred<void>();
      const releaseAdmission = createDeferred<void>();
      const enqueue = alphaQueue.enqueue.bind(alphaQueue);
      alphaQueue.enqueue = async (...args) => {
        const result = await enqueue(...args);
        stored.resolve();
        await releaseAdmission.promise;
        return result;
      };
      const start = (accountId: string) => resources.monitor({ accountId, config });
      try {
        const alpha = await start("alpha");
        await start("beta");
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
        expect(dispatch.mock.calls.map(([{ ctx }]) => ctx.AccountId)).toEqual(["beta"]);

        releaseAdmission.resolve();
        await stopping;
        alphaQueue.enqueue = enqueue;
        const pending = await alphaQueue.listPending({ limit: "all" });
        expect(pending).toHaveLength(1);
        const recovered = observeIngressCompletion(alphaQueue);
        await start("alpha");
        expect(await withinTest(recovered, signal)).toBe(pending[0]?.id);
        expect(dispatch.mock.calls.map(([{ ctx }]) => ctx.AccountId)).toEqual(["beta", "alpha"]);
        expect(dispatch.mock.calls[1]?.[0].ctx).toMatchObject({
          MessageSid: pending[0]?.id,
          BodyForAgent: "recover me",
          ChatType: "group",
          OriginatingTo: "channel:#alpha",
        });
        expect(await alphaQueue.listPending({ limit: "all" })).toEqual([]);
        expect(sockets.get("qa-beta")).toBe(betaSocket);
        expect(betaSocket?.destroyed).toBe(false);
        expect(connections).toBe(3);
      } finally {
        releaseAdmission.resolve();
        alphaQueue.enqueue = enqueue;
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
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
      });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      await withIngressQueue(async (_queue, resources) => {
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
        const server = await resources.server(startMonitorServer({ failSecond: true, loginError }));
        const config = monitorConfig(server.port, "bot", { channels: ["#openclaw"] });

        const monitor = await resources.monitor({ config, statusSink });
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
      });
    },
  );

  it("does not send a delayed private reply through the reconnected client", async () => {
    await withIngressQueue(async (ingressQueue, resources) => {
      const pairingStarted = createDeferred<void>();
      const pairingResult = createDeferred<{ code: string; created: boolean }>();
      const completed = observeIngressCompletion(ingressQueue);
      const { statusSink, reconnected } = observeReconnect();
      installPairingMonitorRuntime(async () => {
        pairingStarted.resolve();
        return await pairingResult.promise;
      });
      const server = await resources.server(
        startMonitorServer({ welcomeNick: "receipt-bot", renameOnReconnect: true }),
      );
      const enqueueSpy = vi.spyOn(ingressQueue, "enqueue");
      try {
        const monitor = await resources.monitor({
          config: monitorConfig(server.port, "receipt-bot", { dmPolicy: "pairing" }),
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

        enqueueSpy.mockRestore();
      }
    });
  });
});

describe("irc monitor inbound target", () => {
  it("maps a channel with a colonless body through the monitor boundary", async () => {
    await withIngressQueue(async (ingressQueue, resources) => {
      const debug = vi.fn();
      const core = installMonitorRuntime(debug, true);
      const dispatch = vi.mocked(core.channel.reply.dispatchReplyWithBufferedBlockDispatcher);
      const server = await resources.server(startMonitorServer());
      const noticeText = "private-notice-sentinel";
      const completed = observeIngressCompletion(ingressQueue);

      await resources.monitor({
        config: monitorConfig(server.port, "bot", openInboundConfig),
      });
      server.sendNotice("#openclaw", noticeText);
      server.sendInbound("#openclaw", true);
      const completedId = await withTimeout(completed, 3000, "inbound IRC message completion");
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0].ctx).toMatchObject({
        MessageSid: completedId,
        ChatType: "group",
        From: "channel:#openclaw",
        To: "channel:#openclaw",
        OriginatingTo: "channel:#openclaw",
        SenderName: "alice",
        SenderId: "alice!ident@example.org",
        RawBody: "hello",
        BodyForAgent: "hello",
      });
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("notice #openclaw"));
      const diagnostics = JSON.stringify(debug.mock.calls);
      expect(diagnostics).not.toContain("hello");
      expect(diagnostics).not.toContain(noticeText);
    });
  });

  it.each([
    [
      "uses the receipt-time nickname when replaying a self echo",
      {
        eventId: "local:previous-connection:000000000001",
        rawLine: ":receipt-bot!ident@example.org PRIVMSG #openclaw :echo",
        laneKey: "channel:#openclaw",
        nick: "reconnected-bot",
        completionLabel: "replayed self echo completion",
      },
    ],
    [
      "does not replay a DM after the accepting connection changed",
      {
        eventId: "local:previous-connection:000000000002",
        rawLine: ":alice!ident@example.org PRIVMSG receipt-bot :private",
        laneKey: "direct:alice",
        nick: "receipt-bot",
        completionLabel: "replayed DM completion",
      },
    ],
  ] as const)("%s", async (_title, { eventId, rawLine, laneKey, nick, completionLabel }) => {
    await withIngressQueue(async (ingressQueue, resources) => {
      const core = installMonitorRuntime();
      const receivedAt = Date.now();
      await ingressQueue.enqueue(
        eventId,
        {
          version: 1,
          eventId,
          receivedAt,
          connectionEpoch: "previous-connection",
          connectedNick: "receipt-bot",
          rawLine,
        },
        { receivedAt, laneKey },
      );
      const server = await resources.server(startMonitorServer({ welcomeNick: nick }));
      const completed = observeIngressCompletion(ingressQueue);

      await resources.monitor({
        config: monitorConfig(server.port, nick, openInboundConfig),
      });
      expect(await withTimeout(completed, 3000, completionLabel)).toBe(eventId);
      expect(await ingressQueue.listPending({ limit: "all" })).toEqual([]);
      expect(await ingressQueue.listClaims()).toEqual([]);
      expect(core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    });
  });

  it("does not record receipt-time self echoes as inbound activity", async () => {
    await withIngressQueue(async (ingressQueue, resources) => {
      const core = installMonitorRuntime();
      const server = await resources.server(startMonitorServer());
      const enqueueSpy = vi.spyOn(ingressQueue, "enqueue");
      const completed = observeIngressCompletion(ingressQueue);
      try {
        const monitor = await resources.monitor({
          config: monitorConfig(server.port, "bot", openInboundConfig),
        });
        server.sendInbound("#openclaw", false, "bot");
        const completedId = await withTimeout(completed, 3000, "receipt-time self echo completion");
        expect(enqueueSpy).toHaveBeenCalledOnce();
        await enqueueSpy.mock.results[0]?.value;
        expect(completedId).toBe(enqueueSpy.mock.calls[0]?.[0]);
        expect(await ingressQueue.listPending({ limit: "all" })).toEqual([]);
        expect(await ingressQueue.listClaims()).toEqual([]);
        await monitor.stop();
        expect(core.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
        expect(core.channel.activity.record).not.toHaveBeenCalled();
      } finally {
        enqueueSpy.mockRestore();
      }
    });
  });
});
