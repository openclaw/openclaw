// Irc tests cover client plugin behavior.
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it, vi } from "vitest";
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
        password: "secret\r\nJOIN #bad",
      },
    });

    expect(result.lines).toContain("PRIVMSG NickServ :IDENTIFY secret JOIN #bad");
  });

  it("sends backslashes in the NickServ password unchanged", async () => {
    const result = await connectAndCollectRegistration({
      nickserv: { password: String.raw`pa\tss\new\x41` },
    });

    expect(result.lines).toContain(String.raw`PRIVMSG NickServ :IDENTIFY pa\tss\new\x41`);
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

  it("sanitizes whitespace and special characters after a collision", async () => {
    const nick = await connectAfterNickCollision("my bot!");
    expect(nick).toMatch(/^mybot_\d*$/);
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

function maxLineBytes(bodies: string[]): number {
  return Math.max(
    ...bodies.map((body) => Buffer.byteLength(`PRIVMSG #general :${body}\r\n`, "utf8")),
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
    lengths?: number[];
    bodies?: string[];
    separator?: string;
  }>([
    { name: "multibyte byte limit", text: "漢".repeat(900) },
    { name: "emoji byte limit", text: "😀".repeat(300) },
    { name: "default ASCII cap", text: "a".repeat(900), lengths: [350, 350, 200] },
    {
      name: "multibyte character cap",
      text: "漢".repeat(250),
      limit: 100,
      lengths: [100, 100, 50],
    },
    {
      name: "character cap below one code point's bytes",
      text: "漢".repeat(10),
      limit: 2,
      lengths: [2, 2, 2, 2, 2],
    },
    {
      name: "astral code point with a one-unit cap",
      text: "😀".repeat(10),
      limit: 1,
      lengths: Array(10).fill(2),
    },
    {
      name: "surrogate pair straddling the cap",
      text: "xxxxxxxxx🙂rest",
      limit: 10,
      bodies: ["xxxxxxxxx", "🙂rest"],
    },
    {
      name: "leading emoji with a one-unit cap",
      text: "🙂A",
      limit: 1,
      bodies: ["🙂", "A"],
    },
    { name: "BMP text with a one-unit cap", text: "ABC", limit: 1, bodies: ["A", "B", "C"] },
    {
      name: "nearby word boundary",
      text: "alpha beta gamma",
      limit: 10,
      bodies: ["alpha beta", "gamma"],
      separator: " ",
    },
  ])(
    "preserves $name",
    async ({ text, limit, lengths, bodies: expectedBodies, separator = "" }) => {
      const server = await startLoopbackIrcServer();
      try {
        const bodies = await collectPrivmsgBodies(server, text, limit);
        expect(bodies.length).toBeGreaterThan(1);
        expect(maxLineBytes(bodies)).toBeLessThanOrEqual(512);
        expect(bodies.some((body) => LONE_SURROGATE.test(body))).toBe(false);
        expect(bodies.join(separator)).toBe(text);
        if (lengths) {
          expect(bodies.map((body) => body.length)).toEqual(lengths);
        }
        if (expectedBodies) {
          expect(bodies).toEqual(expectedBodies);
        }
      } finally {
        await server.close();
      }
    },
  );
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

  it("keeps accepting lines at the IRCv3 tag plus body maximum", async () => {
    const tags = `@${"t".repeat(8189)}=1`;
    const longLine = `${tags} :server NOTICE bot :${"x".repeat(400)}`;
    const server = await startFloodServer({ payload: () => `${longLine}\r\n:server PING :ok\r\n` });
    try {
      const { client, errors, lines, waitForLine } = await connectToFlood(server);
      await withTimeout(
        waitForLine(":server PING :ok"),
        2000,
        "IRC lines after maximal tagged line",
      );
      expect(lines).toContain(longLine);
      expect(errors).toEqual([]);
      expect(client.isReady()).toBe(true);
      client.quit("test complete");
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
