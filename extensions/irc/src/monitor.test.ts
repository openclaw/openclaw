import { describe, expect, it, vi } from "vitest";

vi.mock("./runtime.js", () => ({
  getIrcRuntime: () => ({
    config: { loadConfig: () => ({}) },
    logging: {
      getChildLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      shouldLogVerbose: () => false,
    },
    channel: { activity: { record: vi.fn() } },
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveIrcAccount: () => ({
    accountId: "default",
    configured: true,
    host: "irc.example.com",
    port: 6667,
    tls: false,
    nick: "testbot",
    username: "testbot",
    realname: "Test Bot",
    config: { channels: [] },
  }),
}));

vi.mock("./client.js", () => ({
  connectIrcClient: vi.fn(async () => ({
    nick: "testbot",
    isReady: () => true,
    sendRaw: vi.fn(),
    join: vi.fn(),
    sendPrivmsg: vi.fn(),
    quit: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: (_account: unknown, overrides: Record<string, unknown>) => ({
    host: "irc.example.com",
    port: 6667,
    tls: false,
    nick: "testbot",
    username: "testbot",
    realname: "Test Bot",
    ...overrides,
  }),
}));

import { connectIrcClient } from "./client.js";
import { monitorIrcProvider, resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        target: "#openclaw",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: true,
      target: "#openclaw",
      rawTarget: "#openclaw",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        target: "openclaw-bot",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: false,
      target: "alice",
      rawTarget: "openclaw-bot",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        target: "openclaw-bot",
        senderNick: " ",
      }),
    ).toEqual({
      isGroup: false,
      target: "openclaw-bot",
      rawTarget: "openclaw-bot",
    });
  });
});

describe("monitorIrcProvider lifecycle", () => {
  it("stays pending until the IRC connection closes", async () => {
    const mockConnect = vi.mocked(connectIrcClient);
    mockConnect.mockClear();

    let resolved = false;
    const monitorPromise = monitorIrcProvider({
      config: { channels: { irc: { host: "irc.example.com", nick: "testbot" } } } as never,
      runtime: { exitError: vi.fn() } as never,
    }).then((result) => {
      resolved = true;
      return result;
    });

    // Allow microtasks to flush (connectIrcClient resolves immediately in the mock)
    await new Promise((r) => setTimeout(r, 10));

    // The promise must still be pending — this is the core of the bug fix.
    // Before the fix, monitorIrcProvider resolved right after connectIrcClient,
    // causing the gateway to treat the channel as stopped and auto-restart it.
    expect(resolved).toBe(false);

    // Simulate the IRC socket closing by invoking the onClose callback
    const options = mockConnect.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(typeof options.onClose).toBe("function");
    options.onClose!();

    const result = await monitorPromise;
    expect(resolved).toBe(true);
    expect(typeof result.stop).toBe("function");
  });
});
