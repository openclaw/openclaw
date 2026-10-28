import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ircPlugin } from "./channel.js";
import { connectIrcClient, type IrcClientOptions } from "./client.js";
import { onIrcTestLine, startIrcTestServer as startServer } from "./irc-server.test-support.js";
import { setIrcRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const effectGate = await vi.hoisted(async () =>
  (
    await import("../../test-support/effect-preparation.test-support.js")
  ).createEffectPreparationGate(),
);
// mock-isolation: Share the export-preserving factory, but keep the preparation gate suite-local.
vi.mock("openclaw/plugin-sdk/fetch-runtime", effectGate.mockRuntime);

async function startIrcTestServer(onConnection: (socket: net.Socket) => void) {
  const server = await startServer(onConnection);
  onTestFinished(() => server.close());
  return server;
}

async function connectTestClient(
  server: { port: number },
  overrides: Partial<IrcClientOptions> = {},
) {
  const client = await connectIrcClient({
    host: "127.0.0.1",
    port: server.port,
    tls: false,
    nick: "bot",
    username: "bot",
    realname: "OpenClaw Bot",
    ...overrides,
  });
  onTestFinished(() => client.close());
  return client;
}

type LoopbackIrcServer = Awaited<ReturnType<typeof startLoopbackIrcServer>>;

async function startLoopbackIrcServer(options?: {
  rejectInitialNick?: boolean;
  register?: boolean;
  onLine?: (socket: net.Socket, line: string) => void;
}) {
  const lines: string[] = [];
  const quitReceived = createDeferred<void>();
  const socketClosed = createDeferred<void>();
  let connected = false;
  const server = await startIrcTestServer((socket) => {
    connected = true;
    let awaitingFallbackNick = false;
    socket.on("close", () => socketClosed.resolve());
    onIrcTestLine(socket, (line) => {
      lines.push(line);
      if (line.startsWith("QUIT :")) {
        quitReceived.resolve();
      }
      if (line.startsWith("USER ") && options?.register !== false) {
        if (options?.rejectInitialNick) {
          awaitingFallbackNick = true;
          socket.write(":server 433 * bot :Nickname in use\r\n");
        } else {
          socket.write(":server 001 bot :welcome\r\n");
        }
      } else if (awaitingFallbackNick && line.startsWith("NICK ")) {
        awaitingFallbackNick = false;
        socket.write(`:server 001 ${line.slice("NICK ".length)} :welcome\r\n`);
      }
      options?.onLine?.(socket, line);
    });
  });
  return {
    ...server,
    lines,
    quitReceived: quitReceived.promise,
    get socketClosed() {
      return connected ? socketClosed.promise : Promise.resolve();
    },
  };
}

async function connectAndCollectRegistration(
  params: Pick<IrcClientOptions, "nickserv" | "password">,
) {
  const server = await startLoopbackIrcServer();
  const errors: Error[] = [];
  const client = await connectTestClient(server, {
    ...params,
    onError: (error) => errors.push(error),
  });
  // QUIT follows all registration writes on the same stream; wait for peer receipt.
  client.quit("test complete");
  await withTimeout(server.quitReceived, 1000, "IRC registration output");
  return { lines: server.lines, errors };
}

async function connectAfterNickCollision(nick: string): Promise<string> {
  const server = await startLoopbackIrcServer({ rejectInitialNick: true });
  await connectTestClient(server, { nick });
  const nickLines = server.lines.filter((line) => line.startsWith("NICK "));
  expect(nickLines).toHaveLength(2);
  return nickLines[1]!.slice("NICK ".length);
}

describe("irc client nickserv", () => {
  it("sends REGISTER after IDENTIFY when enabled with email", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: { password: "secret", register: true, registerEmail: "bot@example.com" },
    });

    expect(result.lines.filter((line) => line.startsWith("PRIVMSG NickServ :"))).toEqual([
      "PRIVMSG NickServ :IDENTIFY secret",
      "PRIVMSG NickServ :REGISTER secret bot@example.com",
    ]);
  });

  it("reports register without registerEmail", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: { password: "secret", register: true },
    });

    expect(result.errors[0]?.message).toMatch(/registerEmail/);
  });

  it("sanitizes outbound NickServ payloads", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        service: "NickServ\n",
        password: String.raw`pa\tss\new\x41` + "\u0002\u007f\r\nJOIN #bad",
      },
    });

    expect(result.lines).toContain(String.raw`PRIVMSG NickServ :IDENTIFY pa\tss\new\x41 JOIN #bad`);
  });
});

describe("irc client server password", () => {
  it.each([
    { password: "secret", expected: "PASS secret" },
    { password: "correct horse battery staple", expected: "PASS :correct horse battery staple" },
    { password: ":colon-first", expected: "PASS ::colon-first" },
  ])("sends $password as $expected", async ({ password, expected }) => {
    const result = await connectAndCollectRegistration({ password });

    expect(result.lines[0]).toBe(expected);
  });
});

describe("irc client readiness timeout", () => {
  it("closes the socket when registration never becomes ready", async () => {
    const server = await startLoopbackIrcServer({ register: false });
    await expect(connectTestClient(server, { connectTimeoutMs: 50 })).rejects.toThrow(
      /IRC connect/,
    );
    await withTimeout(server.socketClosed, 1000, "timed-out IRC socket close");
    expect(server.openSocketCount()).toBe(0);
  });
});

describe("irc client fallback nick", () => {
  it("produces unique fallback nicks across sequential collisions", async () => {
    const first = await connectAfterNickCollision("bot");
    const second = await connectAfterNickCollision("bot");
    const third = await connectAfterNickCollision("bot");
    expect(first).toMatch(/^bot_\d*$/);
    expect(second).toMatch(/^bot_\d+$/);
    expect(third).toMatch(/^bot_\d+$/);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it.each([
    ["!!!", /^openclaw_\d*$/],
    ["a".repeat(50), /^a+_\d*$/],
  ] as const)("normalizes and bounds fallback for %s", async (initial, expected) => {
    const nick = await connectAfterNickCollision(initial);
    expect(nick.length).toBeLessThanOrEqual(30);
    expect(nick).toMatch(expected);
  });
});

async function collectPrivmsgBodies(
  server: LoopbackIrcServer,
  text: string,
  messageChunkMaxChars?: number,
): Promise<string[]> {
  const client = await connectTestClient(server, {
    connectTimeoutMs: 5000,
    messageChunkMaxChars,
  });
  await client.sendPrivmsg("#general", text);
  client.quit("test complete");
  await withTimeout(server.quitReceived, 5000, "IRC PRIVMSG output");
  return server.lines
    .filter((line) => line.startsWith("PRIVMSG #general :"))
    .map((line) => line.slice("PRIVMSG #general :".length));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// The line recipients get: the server puts our `:nick!user@host ` in front, and 512 bytes bounds
// that relayed line, so measure it with the longest user@host a server can give us.
const RELAY_PREFIX = `:bot!${"u".repeat(11)}@${"h".repeat(63)} `;

function maxRelayedLineBytes(bodies: string[]): number {
  return Math.max(
    ...bodies.map((body) =>
      Buffer.byteLength(`${RELAY_PREFIX}PRIVMSG #general :${body}\r\n`, "utf8"),
    ),
  );
}

describe("irc client PRIVMSG chunking on the wire", () => {
  afterEach(() => {
    effectGate.prepare = undefined;
  });
  const refusal = new PlatformMessageNotDispatchedError("authority ended", {
    cause: new Error("scheduled sender retired"),
  });
  it("admits all raw chunks before sending the message", async () => {
    const server = await startLoopbackIrcServer();
    let attempts = 0;
    effectGate.prepare = async () => {
      if (++attempts > 1) {
        throw refusal;
      }
    };
    await expect(collectPrivmsgBodies(server, "abcdefghi", 3)).resolves.toEqual([
      "abc",
      "def",
      "ghi",
    ]);
  });

  it("preserves an admission refusal without sending any raw chunks", async () => {
    const server = await startLoopbackIrcServer();
    effectGate.prepare = async () => {
      throw refusal;
    };
    const client = await connectTestClient(server, { messageChunkMaxChars: 3 });
    await expect(client.sendPrivmsg("#general", "abcdefghi")).rejects.toBe(refusal);
    client.quit("refusal test complete");
    await server.quitReceived;
    expect(server.lines.some((line) => line.startsWith("PRIVMSG #general :"))).toBe(false);
  });

  it("retains partial delivery when a later raw socket write fails", async () => {
    const server = await startLoopbackIrcServer();
    const socket = new net.Socket();
    const connect = vi
      .spyOn(net, "connect")
      .mockImplementationOnce((...args) => socket.connect(...args));
    // Node's named exports otherwise retain the original connection factory.
    syncBuiltinESMExports();
    onTestFinished(() => {
      connect.mockRestore();
      syncBuiltinESMExports();
      socket.destroy();
    });
    const client = await connectTestClient(server, { messageChunkMaxChars: 3 });
    const failure = new Error("socket write failed");
    const originalWrite = socket.write.bind(socket);
    let sends = 0;
    // Socket.connect restores write, so install this fault after connection.
    const write = vi.spyOn(socket, "write").mockImplementation((...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("PRIVMSG #general :")) {
        if (++sends === 2) {
          throw failure;
        }
      }
      return originalWrite(...args);
    });
    onTestFinished(() => write.mockRestore());
    const error = await client
      .sendPrivmsg("#general", "abcdefghi")
      .catch((caughtError: unknown) => caughtError);
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect(error).toMatchObject({
      cause: failure,
      deliveryResult: { messageIds: [], visibleReplySent: true },
    });
    client.quit("partial test complete");
    await server.quitReceived;
    expect(server.lines.filter((line) => line.startsWith("PRIVMSG #general :"))).toEqual([
      "PRIVMSG #general :abc",
    ]);
  });

  it.each<[string, string, number?, string[]?, string?]>([
    ["emoji byte limit", "😀".repeat(300)],
    [
      "joined emoji at the character cap",
      `${"x".repeat(348)}👨‍👩‍👧‍👦tail`,
      undefined,
      ["x".repeat(348), "👨‍👩‍👧‍👦tail"],
    ],
    [
      "joined emoji at the byte cap",
      `${"漢".repeat(133)}👨‍👩‍👧‍👦tail`,
      undefined,
      ["漢".repeat(133), "👨‍👩‍👧‍👦tail"],
    ],
    ["nearby word boundary", "alpha beta gamma", 10, ["alpha beta", "gamma"], " "],
  ])("preserves %s", async (_name, text, limit, expectedBodies, separator = "") => {
    const server = await startLoopbackIrcServer();
    const bodies = await collectPrivmsgBodies(server, text, limit);
    expect(bodies.length).toBeGreaterThan(1);
    expect(maxRelayedLineBytes(bodies)).toBeLessThanOrEqual(512);
    expect(bodies.some((body) => LONE_SURROGATE.test(body))).toBe(false);
    expect(bodies.join(separator)).toBe(text);
    if (expectedBodies) {
      expect(bodies).toEqual(expectedBodies);
    }
  });
});

describe("irc client inbound line bound", () => {
  async function startFloodServer(payload: string) {
    return startLoopbackIrcServer({
      onLine: (socket, line) => {
        if (line.startsWith("USER ")) {
          socket.on("error", () => {});
          socket.write(payload);
        }
      },
    });
  }

  async function connectToFlood(server: { port: number }) {
    const errors: Error[] = [];
    const lines: string[] = [];
    const disconnected = createDeferred<void>();
    const client = await connectTestClient(server, {
      onError: (error) => errors.push(error),
      onPrivmsg: (event) => {
        lines.push(event.rawLine);
      },
      onDisconnect: () => disconnected.resolve(),
    });
    return { client, errors, lines, disconnected: disconnected.promise };
  }

  it.each([
    ["unterminated", "A".repeat(256 * 1024)],
    ["terminated", `:peer!test@example.com PRIVMSG bot :${"B".repeat(64 * 1024)}\r\n`],
  ])("drops an oversized %s line without dispatch", async (_kind, payload) => {
    const server = await startFloodServer(payload);
    const { client, errors, lines, disconnected } = await connectToFlood(server);
    await withTimeout(disconnected, 2000, "IRC oversized-line disconnect");
    await withTimeout(server.socketClosed, 2000, "IRC peer socket close");
    expect(errors.some((error) => error.message.includes("longer than"))).toBe(true);
    expect(client.isReady()).toBe(false);
    expect(server.openSocketCount()).toBe(0);
    expect(lines).toEqual([]);
  });

  it("does not retain state across many small chunks of a normal line", async () => {
    const pongReceived = createDeferred<void>();
    const server = await startLoopbackIrcServer({
      onLine: (socket, line) => {
        if (line.startsWith("USER ")) {
          socket.on("error", () => {});
          for (let i = 0; i < 20; i += 1) {
            socket.write(`${"c".repeat(800)}\r\n`);
          }
          socket.write(":server PING :done\r\n");
        } else if (line === "PONG :done") {
          pongReceived.resolve();
        }
      },
    });
    const { client, errors } = await connectToFlood(server);
    await withTimeout(pongReceived.promise, 2000, "IRC repeated normal lines");
    expect(errors).toEqual([]);
    client.quit("test complete");
  });
});

describe("irc client liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function connectToQuietServer(answerPing: boolean) {
    const pingReceived = createDeferred<void>();
    const pongReceived = createDeferred<void>();
    const abort = new AbortController();
    const server = await startLoopbackIrcServer({
      onLine: (socket, line) => {
        if (line === "PING :openclaw") {
          pingReceived.resolve();
          if (answerPing) {
            socket.write(":server PONG server :openclaw\r\n");
            socket.write(":observer!test@example.com PRIVMSG bot :pong-observed\r\n");
          }
        }
      },
    });
    const onError = vi.fn();
    const disconnected = createDeferred<void>();
    const onDisconnect = vi.fn(() => disconnected.resolve());
    const client = await connectTestClient(server, {
      abortSignal: abort.signal,
      onError,
      onDisconnect,
      onPrivmsg: () => pongReceived.resolve(),
    });
    return {
      serverLines: server.lines,
      client,
      abort,
      onError,
      onDisconnect,
      pingReceived: pingReceived.promise,
      pongReceived: pongReceived.promise,
      socketClosed: server.socketClosed,
      disconnected: disconnected.promise,
    };
  }

  it("drops a connection whose server goes silent and reports one disconnect", async ({
    signal,
  }) => {
    const peer = await connectToQuietServer(false);
    await vi.advanceTimersByTimeAsync(120_000);
    await withinTest(peer.pingReceived, signal);
    expect(peer.client.isReady()).toBe(true);

    await vi.advanceTimersByTimeAsync(120_000);
    await withinTest(peer.disconnected, signal);
    expect(peer.onError).toHaveBeenCalledExactlyOnceWith(
      new Error("IRC server sent nothing for 240s; reconnecting"),
    );
    expect(peer.client.isReady()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(peer.onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps a quiet connection whose server answers PING", async ({ signal }) => {
    const peer = await connectToQuietServer(true);
    await vi.advanceTimersByTimeAsync(120_000);
    await withinTest(peer.pongReceived, signal);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(peer.onDisconnect).not.toHaveBeenCalled();
    expect(peer.onError).not.toHaveBeenCalled();
    expect(peer.client.isReady()).toBe(true);
  });

  it.for(["quit", "close", "abort"] as const)(
    "stops liveness checks on %s without requesting reconnect",
    async (shutdown, { signal }) => {
      const peer = await connectToQuietServer(false);
      await vi.advanceTimersByTimeAsync(120_000);
      await withinTest(peer.pingReceived, signal);
      if (shutdown === "abort") {
        peer.abort.abort();
      } else {
        peer.client[shutdown]();
      }
      expect(vi.getTimerCount()).toBe(0);
      await withinTest(peer.socketClosed, signal);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(peer.serverLines.filter((line) => line.startsWith("PING "))).toHaveLength(1);
      expect(peer.onDisconnect).not.toHaveBeenCalled();
      expect(peer.onError).not.toHaveBeenCalled();
      expect(peer.client.isReady()).toBe(false);
    },
  );
});

describe("irc client inbound CTCP", () => {
  it("hands ACTION and plain messages to ingress but not CTCP queries", async () => {
    const inbound = [
      ":scanner!ctcp@scanner.example PRIVMSG bot :\u0001VERSION\u0001",
      ":alice!a@example.com PRIVMSG bot :\u0001PING 1760000000\u0001",
      ":alice!a@example.com PRIVMSG #ops :\u0001TIME\u0001",
      ":alice!a@example.com PRIVMSG bot :\u0001version\u0001",
      ":alice!a@example.com PRIVMSG bot :\u0001pInG 123\u0001",
      ":alice!a@example.com PRIVMSG bot :\u0001time",
      ":alice!a@example.com PRIVMSG bot :\u0001",
      ":alice!a@example.com PRIVMSG bot :\u0001ACTION waves\u0001",
      ":alice!a@example.com PRIVMSG bot :\u0001action waves\u0001",
      ":alice!a@example.com PRIVMSG bot :hello",
      ":alice!a@example.com PRIVMSG bot :VERSION",
      ":alice!a@example.com PRIVMSG bot :hello\u0001",
    ];
    const done = createDeferred<void>();
    const server = await startLoopbackIrcServer({
      onLine: (socket, line) => {
        if (line.startsWith("USER ")) {
          for (const message of inbound) {
            socket.write(`${message}\r\n`);
          }
          socket.write(":server PING :done\r\n");
        } else if (line === "PONG :done") {
          done.resolve();
        }
      },
    });
    const dispatched: string[] = [];
    const client = await connectTestClient(server, {
      onPrivmsg: (event) => {
        dispatched.push(event.rawLine);
      },
    });
    await withTimeout(done.promise, 2000, "IRC inbound CTCP lines");
    expect(dispatched).toEqual(inbound.slice(7));
    client.quit("test complete");
  });
});

describe("IRC formatted text on the wire", () => {
  const sendFormattedIrcText = ircPlugin.outbound!.sendFormattedText!;
  type SendOptions = Partial<Parameters<typeof sendFormattedIrcText>[0]>;
  const padding = "x".repeat(340),
    literal = `${padding} **KEEP_LITERAL**`;
  const label = "word ".repeat(80).trim(),
    url = "https://example.com/docs";
  const prefix = "PRIVMSG #room :";
  let server: LoopbackIrcServer;
  let cfg: CoreConfig;
  const messages = () => server.lines.filter((line) => line.startsWith(prefix));
  const send = async (text: string, options: SendOptions = {}) => {
    const onDeliveryResult = vi.fn(),
      onPlatformSendDispatch = vi.fn();
    const results = await sendFormattedIrcText({
      cfg,
      to: "#room",
      text,
      onDeliveryResult,
      onPlatformSendDispatch,
      ...options,
    });
    await server.socketClosed;
    expect(results).toHaveLength(messages().length);
    for (const callback of [onDeliveryResult, onPlatformSendDispatch]) {
      expect(callback).toHaveBeenCalledTimes(results.length);
    }
    for (const command of ["USER ", "JOIN #room", "QUIT :"]) {
      expect(server.lines.filter((line) => line.startsWith(command))).toHaveLength(1);
    }
    expect(server.openSocketCount()).toBe(0);
    return results;
  };

  beforeEach(async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "irc", plugin: ircPlugin, source: "test" }]),
    );
    server = await startLoopbackIrcServer({
      onLine: (socket, line) => {
        if (line.startsWith("QUIT")) {
          socket.end();
        }
      },
    });
    cfg = { channels: { irc: { host: "127.0.0.1", port: server.port, tls: false, nick: "bot" } } };
  });

  it.each([undefined, "parent-1"])("rejects sanitized-empty (%s)", async (replyToId) => {
    const core = createPluginRuntimeMock();
    setIrcRuntime(core);
    const onDeliveryResult = vi.fn();
    await expect(send("\u0001", { replyToId, onDeliveryResult })).rejects.toThrow(
      "Message must be non-empty for IRC sends",
    );
    await server.socketClosed;
    expect(server.lines.some((line) => line.startsWith("PRIVMSG "))).toBe(false);
    expect(onDeliveryResult).not.toHaveBeenCalled();
    expect(core.channel.activity.record).not.toHaveBeenCalled();
    expect(server.openSocketCount()).toBe(0);
  });

  it("sends literal backslash sequences unchanged with a reply reference", async () => {
    const results = await send(String.raw`Run C:\tools\new.exe or printf("%d\n") with \x41`, {
      replyToId: "parent-1",
    });
    expect(server.lines.filter((line) => line.startsWith("PRIVMSG "))).toEqual([
      String.raw`PRIVMSG #room :Run C:\tools\new.exe or printf("%d\n") with \x41  [reply:parent-1]`,
    ]);
    expect(results[0]?.receipt?.replyToId).toBe("parent-1");
  });

  it.each([
    ["code", "PRIVMSG #room :| Name | State | | ---- | ----- | | docs | ready |"],
    ["bullets", "PRIVMSG #room :docs \u2022 State: ready"],
  ] as const)("renders %s tables as plain text on the wire", async (mode, expected) => {
    cfg.channels!.irc!.markdown = { tables: mode };
    await send("  | Name | State |\n| --- | --- |\n| **docs** | ready |  ");
    expect(server.lines.filter((line) => line.startsWith("PRIVMSG "))).toEqual([expected]);
  });

  it.each([
    ["fenced literals across chunks", `\`\`\`text\n${padding}\n**KEEP_LITERAL**\n\`\`\``, literal],
    ["a closing fence beyond chunks", `\`\`\`text\n${"x".repeat(345)}\n\`\`\``, "x".repeat(345)],
    ["inline literals across chunks", `\`${literal}\``, literal],
    ["a long link label and its destination", `[${label}](${url})`, `${label} (${url})`],
  ])("preserves %s", async (_name, text, expected) => {
    await send(text);
    expect(
      messages()
        .map((line) => line.slice(prefix.length))
        .join(" "),
    ).toBe(expected);
  });

  it.each([
    { source: "implicit", mode: "first", textLimit: undefined, replies: "first" },
    { source: "implicit", mode: "all", textLimit: undefined, replies: "all" },
    { source: "explicit", mode: "first", textLimit: 16, replies: "all" },
  ] as const)(
    "$source/$mode replies, limit $textLimit",
    async ({ source, mode, textLimit, replies }) => {
      cfg.channels!.irc!.textChunkLimit = 40;
      cfg.channels!.irc!.accounts = { work: { textChunkLimit: 10 } };
      const results = await send("**alpha beta gamma delta**", {
        accountId: "work",
        formatting: textLimit ? { textLimit } : undefined,
        replyToId: "parent-1",
        replyToIdSource: source,
        replyToMode: mode,
      });
      const sent = messages(),
        replyCount = replies === "first" ? 1 : sent.length;
      expect(results.filter(({ receipt }) => receipt?.replyToId === "parent-1")).toHaveLength(
        replyCount,
      );
      expect(sent.filter((line) => line.endsWith("[reply:parent-1]"))).toHaveLength(replyCount);
      const bodies = sent.map((line) =>
        line.slice(prefix.length).replace(/ {2}\[reply:parent-1\]$/, ""),
      );
      expect(bodies.join(" ")).toBe("alpha beta gamma delta");
      expect(bodies.every((body) => body.length <= (textLimit ?? 10))).toBe(true);
      if (textLimit) {
        expect(bodies.some((body) => body.length > 10)).toBe(true);
      }
    },
  );
});
