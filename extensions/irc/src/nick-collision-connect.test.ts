/**
 * Tests for connectIrcClient's nick-collision recovery path
 * (tryRecoverNickCollision).
 *
 * The node:net module is mocked so that `connectIrcClient` uses a fake
 * in-memory socket instead of opening a real TCP connection. Tests push IRC
 * lines through the fake socket to exercise the 433/436 handling.
 *
 * This file is intentionally separate from nick-collision.test.ts, which
 * mocks `client.js` for send/probe tests. Vitest hoists vi.mock() so having
 * both in the same file would replace the real connectIrcClient.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake socket
// ---------------------------------------------------------------------------
class FakeSocket extends EventEmitter {
  written: string[] = [];

  setEncoding(_enc: string) {}

  write(data: string) {
    this.written.push(data);
    return true;
  }

  end() {
    this.emit("close");
  }

  destroy() {
    this.emit("close");
  }

  /** Push one or more IRC lines as if sent by the server. */
  serverSend(...lines: string[]) {
    this.emit("data", lines.map((l) => `${l}\r\n`).join(""));
  }
}

let activeFakeSocket = new FakeSocket();

vi.mock("node:net", () => ({
  default: { connect: () => activeFakeSocket },
  connect: () => activeFakeSocket,
}));

vi.mock("node:tls", () => ({
  default: { connect: () => activeFakeSocket },
  connect: () => activeFakeSocket,
}));

// ---------------------------------------------------------------------------
// Import the REAL connectIrcClient — after the node:net/tls mocks above
// ---------------------------------------------------------------------------
import { connectIrcClient, type IrcClientOptions } from "./client.js";

function baseOptions(overrides: Partial<IrcClientOptions> = {}): IrcClientOptions {
  return {
    host: "irc.example.com",
    port: 6667,
    tls: false,
    nick: "openclaw",
    username: "oc",
    realname: "OpenClaw Bot",
    connectTimeoutMs: 5000,
    ...overrides,
  };
}

async function simulateConnect() {
  await Promise.resolve();
  activeFakeSocket.emit("connect");
  await Promise.resolve();
}

describe("connectIrcClient — 433 nick collision recovery", () => {
  beforeEach(() => {
    activeFakeSocket = new FakeSocket();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Sanity: normal connect path (no collision)
  // -------------------------------------------------------------------------
  it("connects successfully when no 433 is received", async () => {
    const clientPromise = connectIrcClient(baseOptions());

    await simulateConnect();
    activeFakeSocket.serverSend(":server.example.com 001 openclaw :Welcome openclaw");
    await Promise.resolve();

    const client = await clientPromise;
    expect(client.nick).toBe("openclaw");
    expect(client.isReady()).toBe(true);
    client.close();
  });

  // -------------------------------------------------------------------------
  // 2a. NickServ GHOST recovery path
  // -------------------------------------------------------------------------
  it("sends NickServ GHOST + NICK retry when 433 received and NickServ is configured", async () => {
    const clientPromise = connectIrcClient(
      baseOptions({
        nickserv: { enabled: true, password: "nspassword", service: "NickServ" },
      }),
    );

    await simulateConnect();
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    const written = activeFakeSocket.written.join("");
    expect(written).toContain("PRIVMSG NickServ :GHOST openclaw nspassword");
    expect(written).toContain("NICK openclaw");

    // Server grants the welcome after GHOST + re-NICK.
    activeFakeSocket.serverSend(":server.example.com 001 openclaw :Welcome openclaw");
    await Promise.resolve();

    const client = await clientPromise;
    expect(client.nick).toBe("openclaw");
    expect(client.isReady()).toBe(true);
    client.close();
  });

  it("uses a custom NickServ service name when specified", async () => {
    const clientPromise = connectIrcClient(
      baseOptions({
        nickserv: { enabled: true, password: "pass123", service: "ChanServ" },
      }),
    );

    await simulateConnect();
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    expect(activeFakeSocket.written.join("")).toContain("PRIVMSG ChanServ :GHOST openclaw pass123");

    activeFakeSocket.serverSend(":server.example.com 001 openclaw :Welcome");
    await Promise.resolve();
    const client = await clientPromise;
    client.close();
  });

  // -------------------------------------------------------------------------
  // 2b. Fallback nick (nick_) path
  // -------------------------------------------------------------------------
  it("falls back to nick_ when 433 received and NickServ is not configured", async () => {
    const clientPromise = connectIrcClient(baseOptions());

    await simulateConnect();
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    const written = activeFakeSocket.written.join("");
    expect(written).toContain("NICK openclaw_");
    expect(written).not.toContain("GHOST");

    activeFakeSocket.serverSend(":server.example.com 001 openclaw_ :Welcome openclaw_");
    await Promise.resolve();

    const client = await clientPromise;
    expect(client.nick).toBe("openclaw_");
    client.close();
  });

  it("falls back to nick_ when NickServ is explicitly disabled", async () => {
    const clientPromise = connectIrcClient(
      baseOptions({ nickserv: { enabled: false, password: "secret" } }),
    );

    await simulateConnect();
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    const written = activeFakeSocket.written.join("");
    expect(written).not.toContain("GHOST");
    expect(written).toContain("NICK openclaw_");

    activeFakeSocket.serverSend(":server.example.com 001 openclaw_ :Welcome openclaw_");
    await Promise.resolve();

    const client = await clientPromise;
    expect(client.nick).toBe("openclaw_");
    client.close();
  });

  it("falls back to nick_ when NickServ is enabled but has no password configured", async () => {
    const clientPromise = connectIrcClient(baseOptions({ nickserv: { enabled: true } }));

    await simulateConnect();
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    const written = activeFakeSocket.written.join("");
    expect(written).not.toContain("GHOST");
    expect(written).toContain("NICK openclaw_");

    activeFakeSocket.serverSend(":server.example.com 001 openclaw_ :Welcome openclaw_");
    await Promise.resolve();

    const client = await clientPromise;
    expect(client.nick).toBe("openclaw_");
    client.close();
  });

  // -------------------------------------------------------------------------
  // 2c. All recovery attempts exhausted → reject
  // -------------------------------------------------------------------------
  it("rejects with a 433 error when no more recovery options remain (no NickServ)", async () => {
    const clientPromise = connectIrcClient(baseOptions());

    await simulateConnect();
    // 1st 433 → fallback nick sent.
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    // 2nd 433 → no fallback left, should reject.
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw_ :Nickname is already in use");
    await Promise.resolve();

    await expect(clientPromise).rejects.toThrow(/433/);
  });

  it("rejects after NickServ GHOST + fallback are both exhausted", async () => {
    const clientPromise = connectIrcClient(
      baseOptions({ nickserv: { enabled: true, password: "nspassword" } }),
    );

    await simulateConnect();
    // 1st 433 → NickServ GHOST attempted.
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    // 2nd 433 → fallback nick (openclaw_) attempted.
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw :Nickname is already in use");
    await Promise.resolve();

    // 3rd 433 → no options left.
    activeFakeSocket.serverSend(":server.example.com 433 * openclaw_ :Nickname is already in use");
    await Promise.resolve();

    await expect(clientPromise).rejects.toThrow(/433/);
  });

  // -------------------------------------------------------------------------
  // 436 (nick collision hold) treated the same as 433
  // -------------------------------------------------------------------------
  it("applies fallback-nick recovery for 436 (nick collision hold)", async () => {
    const clientPromise = connectIrcClient(baseOptions());

    await simulateConnect();
    activeFakeSocket.serverSend(":server.example.com 436 * openclaw :Nickname collision KILL");
    await Promise.resolve();

    expect(activeFakeSocket.written.join("")).toContain("NICK openclaw_");

    activeFakeSocket.serverSend(":server.example.com 001 openclaw_ :Welcome openclaw_");
    await Promise.resolve();

    const client = await clientPromise;
    expect(client.nick).toBe("openclaw_");
    client.close();
  });

  // -------------------------------------------------------------------------
  // Nick truncation: nick at max length gets a truncated _ suffix
  // -------------------------------------------------------------------------
  it("truncates the fallback nick when the base nick is at the 30-char limit", async () => {
    const longNick = "a".repeat(30); // exactly at max
    const clientPromise = connectIrcClient(baseOptions({ nick: longNick }));

    await simulateConnect();
    activeFakeSocket.serverSend(
      `:server.example.com 433 * ${longNick} :Nickname is already in use`,
    );
    await Promise.resolve();

    const written = activeFakeSocket.written.join("");
    // The fallback should end with _ and be at most 30 chars.
    const nickMatch = written.match(/NICK (\S+)/g);
    const fallbackNickCmd = nickMatch?.find((c) => c.includes("_"));
    expect(fallbackNickCmd).toBeTruthy();
    const fallbackNick = fallbackNickCmd!.replace("NICK ", "");
    expect(fallbackNick.length).toBeLessThanOrEqual(30);
    expect(fallbackNick.endsWith("_")).toBe(true);

    activeFakeSocket.serverSend(`:server.example.com 001 ${fallbackNick} :Welcome ${fallbackNick}`);
    await Promise.resolve();
    const client = await clientPromise;
    expect(client.nick).toBe(fallbackNick);
    client.close();
  });
});
