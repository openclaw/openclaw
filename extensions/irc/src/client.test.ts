// Irc tests cover client plugin behavior.
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { connectIrcClient } from "./client.js";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";

const effectGate = vi.hoisted(() => ({
  beforeInitiate: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const beforeInitiate = effectGate.beforeInitiate;
      return beforeInitiate
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await beforeInitiate();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

type LoopbackIrcServer = {
  port: number;
  lines: string[];
  quitReceived: Promise<void>;
  close(): Promise<void>;
};

type HangingIrcServer = {
  port: number;
  acceptedCount: number;
  closedCount: number;
  socketClosed: Promise<void>;
  openSocketCount(): number;
  close(): Promise<void>;
};

async function startLoopbackIrcServer(options?: {
  rejectInitialNick?: boolean;
}): Promise<LoopbackIrcServer> {
  const lines: string[] = [];
  const quitReceived = createDeferred<void>();
  const server = await startIrcTestServer((socket) => {
    let awaitingFallbackNick = false;
    onIrcTestLine(socket, (line) => {
      lines.push(line);
      if (line.startsWith("QUIT :")) {
        quitReceived.resolve();
      }
      if (line.startsWith("USER ")) {
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
    });
  });
  return { ...server, lines, quitReceived: quitReceived.promise };
}

async function connectAndCollectRegistration(params: {
  nickserv?: NonNullable<Parameters<typeof connectIrcClient>[0]["nickserv"]>;
  password?: string;
}): Promise<{ lines: string[]; errors: Error[] }> {
  const server = await startLoopbackIrcServer();
  const errors: Error[] = [];
  let client: Awaited<ReturnType<typeof connectIrcClient>> | undefined;
  try {
    client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick: "bot",
      username: "bot",
      realname: "OpenClaw Bot",
      password: params.password,
      nickserv: params.nickserv,
      onError: (error) => errors.push(error),
    });
    // QUIT follows all registration writes on the same stream; wait for peer receipt.
    client.quit("test complete");
    await withTimeout(server.quitReceived, 1000, "IRC registration output");
    return { lines: [...server.lines], errors };
  } finally {
    client?.close();
    await server.close();
  }
}

async function connectAfterNickCollision(nick: string): Promise<string> {
  const server = await startLoopbackIrcServer({ rejectInitialNick: true });
  let client: Awaited<ReturnType<typeof connectIrcClient>> | undefined;
  try {
    client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick,
      username: "bot",
      realname: "OpenClaw Bot",
    });
    const nickLines = server.lines.filter((line) => line.startsWith("NICK "));
    expect(nickLines).toHaveLength(2);
    return nickLines[1]!.slice("NICK ".length);
  } finally {
    client?.close();
    await server.close();
  }
}

async function startHangingIrcServer(): Promise<HangingIrcServer> {
  let acceptedCount = 0;
  let closedCount = 0;
  const socketClosed = createDeferred<void>();
  const server = await startIrcTestServer((socket) => {
    acceptedCount += 1;
    socket.on("data", () => {});
    socket.on("close", () => {
      closedCount += 1;
      socketClosed.resolve();
    });
  });
  return {
    ...server,
    socketClosed: socketClosed.promise,
    get acceptedCount() {
      return acceptedCount;
    },
    get closedCount() {
      return closedCount;
    },
  };
}

describe("irc client nickserv", () => {
  it("sends REGISTER after IDENTIFY when enabled with email", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        password: "secret",
        register: true,
        registerEmail: "bot@example.com",
      },
    });

    expect(result.lines.filter((line) => line.startsWith("PRIVMSG NickServ :"))).toEqual([
      "PRIVMSG NickServ :IDENTIFY secret",
      "PRIVMSG NickServ :REGISTER secret bot@example.com",
    ]);
  });

  it("reports register without registerEmail", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        password: "secret",
        register: true,
      },
    });

    expect(result.errors[0]?.message).toMatch(/registerEmail/);
  });

  it("sanitizes outbound NickServ payloads", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: {
        service: "NickServ\n",
        password: String.raw`pa\tss\new\x41` + "\r\nJOIN #bad",
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
    const server = await startHangingIrcServer();
    try {
      await expect(
        connectIrcClient({
          host: "127.0.0.1",
          port: server.port,
          tls: false,
          nick: "bot",
          username: "bot",
          realname: "OpenClaw Bot",
          connectTimeoutMs: 50,
        }),
      ).rejects.toThrow(/IRC connect/);

      await withTimeout(server.socketClosed, 1000, "timed-out IRC socket close");
      expect(server.acceptedCount).toBeGreaterThanOrEqual(1);
      expect(server.closedCount).toBeGreaterThanOrEqual(1);
      expect(server.openSocketCount()).toBe(0);
    } finally {
      await server.close();
    }
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

  it("falls back to openclaw when a colliding nick is entirely special characters", async () => {
    const nick = await connectAfterNickCollision("!!!");
    expect(nick).toMatch(/^openclaw_\d*$/);
  });

  it("truncates a long fallback nick to 30 characters", async () => {
    const longNick = "a".repeat(50);
    const nick = await connectAfterNickCollision(longNick);
    expect(nick.length).toBeLessThanOrEqual(30);
    expect(nick).toMatch(/^a+_\d*$/);
  });
});

async function collectPrivmsgBodies(
  server: LoopbackIrcServer,
  text: string,
  messageChunkMaxChars?: number,
): Promise<string[]> {
  const client = await connectIrcClient({
    host: "127.0.0.1",
    port: server.port,
    tls: false,
    nick: "bot",
    username: "bot",
    realname: "OpenClaw Bot",
    connectTimeoutMs: 5000,
    messageChunkMaxChars,
  });
  try {
    await client.sendPrivmsg("#general", text);
    client.quit("test complete");
    await withTimeout(server.quitReceived, 5000, "IRC PRIVMSG output");
    return server.lines
      .filter((line) => line.startsWith("PRIVMSG #general :"))
      .map((line) => line.slice("PRIVMSG #general :".length));
  } finally {
    client.close();
  }
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
  it("admits all raw chunks before sending the message", async () => {
    const server = await startLoopbackIrcServer();
    const refusal = new PlatformMessageNotDispatchedError("authority ended", {
      cause: new Error("scheduled sender retired"),
    });
    let attempts = 0;
    effectGate.beforeInitiate = async () => {
      if (++attempts > 1) {
        throw refusal;
      }
    };
    try {
      await expect(collectPrivmsgBodies(server, "abcdefghi", 3)).resolves.toEqual([
        "abc",
        "def",
        "ghi",
      ]);
    } finally {
      effectGate.beforeInitiate = undefined;
      await server.close();
    }
  });

  it("preserves an admission refusal without sending any raw chunks", async () => {
    const server = await startLoopbackIrcServer();
    const refusal = new PlatformMessageNotDispatchedError("authority ended", {
      cause: new Error("scheduled sender retired"),
    });
    effectGate.beforeInitiate = async () => {
      throw refusal;
    };
    const client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick: "bot",
      username: "bot",
      realname: "OpenClaw Bot",
      messageChunkMaxChars: 3,
    });
    try {
      await expect(client.sendPrivmsg("#general", "abcdefghi")).rejects.toBe(refusal);
      client.quit("refusal test complete");
      await server.quitReceived;
      expect(server.lines.some((line) => line.startsWith("PRIVMSG #general :"))).toBe(false);
    } finally {
      effectGate.beforeInitiate = undefined;
      client.close();
      await server.close();
    }
  });

  it("retains partial delivery when a later raw socket write fails", async () => {
    const server = await startLoopbackIrcServer();
    const socket = new net.Socket();
    const connect = vi
      .spyOn(net, "connect")
      .mockImplementationOnce((...args) => socket.connect(...args));
    // Node's named exports otherwise retain the original connection factory.
    syncBuiltinESMExports();
    try {
      const client = await connectIrcClient({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        nick: "bot",
        username: "bot",
        realname: "OpenClaw Bot",
        messageChunkMaxChars: 3,
      });
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
      try {
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
      } finally {
        write.mockRestore();
        client.close();
      }
    } finally {
      connect.mockRestore();
      syncBuiltinESMExports();
      socket.destroy();
      await server.close();
    }
  });

  it("rejects text that becomes empty after transport sanitization", async () => {
    const server = await startLoopbackIrcServer();
    try {
      await expect(collectPrivmsgBodies(server, "\u0001")).rejects.toThrow(
        "Message must be non-empty for IRC sends",
      );
      expect(server.lines.some((line) => line.startsWith("PRIVMSG "))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it.each<{
    name: string;
    text: string;
    limit?: number;
    bodies?: string[];
    separator?: string;
  }>([
    { name: "emoji byte limit", text: "😀".repeat(300) },
    {
      name: "joined emoji at the character cap",
      text: `${"x".repeat(348)}👨‍👩‍👧‍👦tail`,
      bodies: ["x".repeat(348), "👨‍👩‍👧‍👦tail"],
    },
    {
      name: "joined emoji at the byte cap",
      text: `${"漢".repeat(133)}👨‍👩‍👧‍👦tail`,
      bodies: ["漢".repeat(133), "👨‍👩‍👧‍👦tail"],
    },
    {
      name: "nearby word boundary",
      text: "alpha beta gamma",
      limit: 10,
      bodies: ["alpha beta", "gamma"],
      separator: " ",
    },
  ])("preserves $name", async ({ text, limit, bodies: expectedBodies, separator = "" }) => {
    const server = await startLoopbackIrcServer();
    try {
      const bodies = await collectPrivmsgBodies(server, text, limit);
      expect(bodies.length).toBeGreaterThan(1);
      expect(maxRelayedLineBytes(bodies)).toBeLessThanOrEqual(512);
      expect(bodies.some((body) => LONE_SURROGATE.test(body))).toBe(false);
      expect(bodies.join(separator)).toBe(text);
      if (expectedBodies) {
        expect(bodies).toEqual(expectedBodies);
      }
    } finally {
      await server.close();
    }
  });
});

describe("irc client inbound line bound", () => {
  type FloodOptions = {
    payload: () => string;
    terminated?: boolean;
  };

  async function startFloodServer(options: FloodOptions) {
    const closed = createDeferred<void>();
    const server = await startIrcTestServer((socket) => {
      socket.on("error", () => {});
      socket.on("close", () => closed.resolve());
      onIrcTestLine(socket, (line) => {
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
          socket.write(options.payload());
        }
      });
    });
    return { ...server, socketClosed: closed.promise };
  }

  async function connectToFlood(server: { port: number }) {
    const errors: Error[] = [];
    const lines: string[] = [];
    const lineWaiters = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const waitForLine = (expected: string) => {
      if (lines.includes(expected)) {
        return Promise.resolve();
      }
      const waiter = lineWaiters.get(expected) ?? createDeferred<void>();
      lineWaiters.set(expected, waiter);
      return waiter.promise;
    };
    const disconnected = createDeferred<void>();
    const client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick: "bot",
      username: "bot",
      realname: "OpenClaw Bot",
      onError: (error) => errors.push(error),
      onLine: (line) => {
        lines.push(line);
        lineWaiters.get(line)?.resolve();
      },
      onDisconnect: () => disconnected.resolve(),
    });
    return { client, errors, lines, waitForLine, disconnected: disconnected.promise };
  }

  it("drops a peer that never terminates a line and reports a disconnect", async () => {
    const server = await startFloodServer({ payload: () => "A".repeat(256 * 1024) });
    try {
      const { client, errors, disconnected } = await connectToFlood(server);
      await withTimeout(disconnected, 2000, "IRC disconnect after unterminated flood");
      await withTimeout(server.socketClosed, 2000, "IRC peer socket close");
      expect(errors.some((error) => error.message.includes("longer than"))).toBe(true);
      expect(client.isReady()).toBe(false);
      expect(server.openSocketCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("drops a peer that sends an oversized terminated line", async () => {
    const server = await startFloodServer({ payload: () => `${"B".repeat(64 * 1024)}\r\n` });
    try {
      const { errors, lines, disconnected } = await connectToFlood(server);
      await withTimeout(disconnected, 2000, "IRC disconnect after oversized line");
      expect(errors.some((error) => error.message.includes("longer than"))).toBe(true);
      expect(lines.some((line) => line.startsWith("BBBB"))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("does not retain state across many small chunks of a normal line", async () => {
    const chunks = Array.from({ length: 2000 }, () => "c".repeat(8));
    const server = await startIrcTestServer((socket) => {
      socket.on("error", () => {});
      onIrcTestLine(socket, (line) => {
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
          for (let i = 0; i < 20; i += 1) {
            socket.write(`${chunks.slice(0, 100).join("")}\r\n`);
          }
          socket.write(":server PING :done\r\n");
        }
      });
    });
    try {
      const { client, errors, waitForLine } = await connectToFlood(server);
      await withTimeout(waitForLine(":server PING :done"), 2000, "IRC repeated normal lines");
      expect(errors).toEqual([]);
      client.quit("test complete");
    } finally {
      await server.close();
    }
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
    const serverLines: string[] = [];
    const pingReceived = createDeferred<void>();
    const pongReceived = createDeferred<void>();
    const socketClosed = createDeferred<void>();
    const abort = new AbortController();
    const server = await startIrcTestServer((socket) => {
      socket.on("close", () => socketClosed.resolve());
      onIrcTestLine(socket, (line) => {
        serverLines.push(line);
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
        } else if (line === "PING :openclaw") {
          pingReceived.resolve();
          if (answerPing) {
            socket.write(":server PONG server :openclaw\r\n");
          }
        }
      });
    });
    onTestFinished(() => server.close());
    const onError = vi.fn();
    const disconnected = createDeferred<void>();
    const onDisconnect = vi.fn(() => disconnected.resolve());
    const client = await connectIrcClient({
      host: "127.0.0.1",
      port: server.port,
      tls: false,
      nick: "bot",
      username: "bot",
      realname: "OpenClaw Bot",
      abortSignal: abort.signal,
      onError,
      onDisconnect,
      onLine: (line) => {
        if (line === ":server PONG server :openclaw") {
          pongReceived.resolve();
        }
      },
    });
    onTestFinished(() => client.close());
    return {
      serverLines,
      client,
      abort,
      onError,
      onDisconnect,
      pingReceived: pingReceived.promise,
      pongReceived: pongReceived.promise,
      socketClosed: socketClosed.promise,
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
    const server = await startIrcTestServer((socket) => {
      onIrcTestLine(socket, (line) => {
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
          for (const message of inbound) {
            socket.write(`${message}\r\n`);
          }
          socket.write(":server PING :done\r\n");
        }
      });
    });
    const done = createDeferred<void>();
    const dispatched: string[] = [];
    try {
      const client = await connectIrcClient({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        nick: "bot",
        username: "bot",
        realname: "OpenClaw Bot",
        onPrivmsg: (event) => {
          dispatched.push(event.rawLine);
        },
        onLine: (line) => {
          if (line === ":server PING :done") {
            done.resolve();
          }
        },
      });
      await withTimeout(done.promise, 2000, "IRC inbound CTCP lines");
      expect(dispatched).toEqual(inbound.slice(7));
      client.quit("test complete");
    } finally {
      await server.close();
    }
  });
});
