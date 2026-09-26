// Irc tests cover client plugin behavior.
import type { Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it } from "vitest";
import { connectIrcClient } from "./client.js";
import { onIrcTestLine, startIrcTestServer } from "./irc-server.test-support.js";

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
  nickserv: NonNullable<Parameters<typeof connectIrcClient>[0]["nickserv"]>;
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
    client.sendPrivmsg("#general", text);
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
  it("rejects text that becomes empty after transport sanitization", async () => {
    const server = await startLoopbackIrcServer();
    try {
      await expect(collectPrivmsgBodies(server, String.raw`\u0001`)).rejects.toThrow(
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

async function startWritableLoopbackIrcServer(options?: {
  onRegistered?: (socket: Socket) => void;
}): Promise<
  LoopbackIrcServer & {
    openSocketCount: () => number;
    writeToClients: (data: string) => void;
    peerClosed: Promise<void>;
    pongReceived: Promise<void>;
  }
> {
  const lines: string[] = [];
  const sockets = new Set<Socket>();
  const peerClosed = createDeferred<void>();
  const pongReceived = createDeferred<void>();
  const server = await startIrcTestServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      peerClosed.resolve();
    });
    onIrcTestLine(socket, (line) => {
      lines.push(line);
      if (line.startsWith("PONG :")) {
        pongReceived.resolve();
      }
      if (line.startsWith("USER ")) {
        if (options?.onRegistered) {
          options.onRegistered(socket);
        } else {
          socket.write(":server 001 bot :welcome\r\n");
        }
      }
    });
  });
  return {
    ...server,
    lines,
    openSocketCount: () => sockets.size,
    writeToClients: (data) => {
      for (const socket of sockets) {
        socket.write(data);
      }
    },
    peerClosed: peerClosed.promise,
    pongReceived: pongReceived.promise,
    quitReceived: Promise.resolve(),
  };
}

describe("irc client inbound line byte limit", () => {
  it("reports an error and closes on an oversized unterminated line", async () => {
    const server = await startWritableLoopbackIrcServer();
    const errors: Error[] = [];
    let disconnects = 0;
    try {
      const client = await connectIrcClient({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        nick: "bot",
        username: "bot",
        realname: "OpenClaw Bot",
        connectTimeoutMs: 5000,
        onError: (error) => errors.push(error),
        onDisconnect: () => {
          disconnects += 1;
        },
      });

      server.writeToClients("x".repeat(1024 * 1024));

      await withTimeout(server.peerClosed, 1000, "oversized IRC input to close the socket");
      expect(errors.map((error) => error.message)).toContain(
        "IRC inbound line exceeds the 512-byte limit",
      );
      expect(disconnects).toBe(1);
      expect(client.isReady()).toBe(false);
      expect(server.openSocketCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("accepts a legal 510-byte line split across socket writes", async () => {
    const server = await startWritableLoopbackIrcServer();
    const receivedLines: string[] = [];
    const line = `PING :${"x".repeat(504)}`;
    const lineReceived = createDeferred<void>();
    let disconnects = 0;
    try {
      const client = await connectIrcClient({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        nick: "bot",
        username: "bot",
        realname: "OpenClaw Bot",
        connectTimeoutMs: 5000,
        onDisconnect: () => {
          disconnects += 1;
        },
        onLine: (entry) => {
          receivedLines.push(entry);
          if (entry === line) {
            lineReceived.resolve();
          }
        },
      });

      server.writeToClients(line.slice(0, 300));
      server.writeToClients(`${line.slice(300)}\r\n`);

      await withTimeout(
        Promise.all([lineReceived.promise, server.pongReceived]),
        1000,
        "split legal IRC line",
      );
      expect(Buffer.byteLength(`${line}\r\n`, "utf8")).toBe(512);
      expect(receivedLines).toContain(line);
      expect(client.isReady()).toBe(true);
      client.close();
      expect(disconnects).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("applies the inbound limit to UTF-8 bytes", async () => {
    const server = await startWritableLoopbackIrcServer();
    const errors: Error[] = [];
    let disconnects = 0;
    try {
      await connectIrcClient({
        host: "127.0.0.1",
        port: server.port,
        tls: false,
        nick: "bot",
        username: "bot",
        realname: "OpenClaw Bot",
        connectTimeoutMs: 5000,
        onError: (error) => errors.push(error),
        onDisconnect: () => {
          disconnects += 1;
        },
      });

      server.writeToClients(`NOTICE bot :${"猫".repeat(167)}\r\n`);

      await withTimeout(server.peerClosed, 1000, "multibyte oversized IRC line to close");
      expect(errors.map((error) => error.message)).toContain(
        "IRC inbound line exceeds the 512-byte limit",
      );
      expect(disconnects).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("stays quiet when an oversized line arrives before registration", async () => {
    let disconnects = 0;
    const server = await startWritableLoopbackIrcServer({
      onRegistered: (socket) => {
        socket.write("x".repeat(600));
      },
    });
    try {
      await expect(
        connectIrcClient({
          host: "127.0.0.1",
          port: server.port,
          tls: false,
          nick: "bot",
          username: "bot",
          realname: "OpenClaw Bot",
          connectTimeoutMs: 1000,
          onDisconnect: () => {
            disconnects += 1;
          },
        }),
      ).rejects.toThrow("IRC inbound line exceeds the 512-byte limit");
      await withTimeout(server.peerClosed, 1000, "pre-registration oversized IRC close");
      expect(disconnects).toBe(0);
      expect(server.openSocketCount()).toBe(0);
    } finally {
      await server.close();
    }
  });
});
