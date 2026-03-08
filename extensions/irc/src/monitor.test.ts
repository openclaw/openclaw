import { describe, expect, it, vi } from "vitest";
import {
  _testResetActiveIrcClients,
  _testSetActiveIrcClient,
  resolveIrcInboundTarget,
} from "./monitor.js";

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

describe("irc monitor active client replacement", () => {
  it("quits previous active client when replacing same account", () => {
    _testResetActiveIrcClients();

    const previousQuit = vi.fn();
    const previous = {
      nick: "OpenClaw",
      isReady: () => true,
      sendRaw: () => {},
      join: () => {},
      sendPrivmsg: () => {},
      quit: previousQuit,
      close: () => {},
    };

    const next = {
      nick: "OpenClaw",
      isReady: () => true,
      sendRaw: () => {},
      join: () => {},
      sendPrivmsg: () => {},
      quit: vi.fn(),
      close: () => {},
    };

    _testSetActiveIrcClient("default", previous);
    _testSetActiveIrcClient("default", next);

    expect(previousQuit).toHaveBeenCalledWith("restart");

    _testResetActiveIrcClients();
  });
});
