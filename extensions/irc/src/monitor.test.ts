import { describe, expect, it } from "vitest";
import { resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        target: "#smart-agent-neo",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: true,
      target: "#smart-agent-neo",
      rawTarget: "#smart-agent-neo",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        target: "smart-agent-neo-bot",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: false,
      target: "alice",
      rawTarget: "smart-agent-neo-bot",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        target: "smart-agent-neo-bot",
        senderNick: " ",
      }),
    ).toEqual({
      isGroup: false,
      target: "smart-agent-neo-bot",
      rawTarget: "smart-agent-neo-bot",
    });
  });
});
