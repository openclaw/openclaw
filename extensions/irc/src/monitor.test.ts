import { describe, expect, it } from "vitest";
import { resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        target: "#activi",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: true,
      target: "#activi",
      rawTarget: "#activi",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        target: "activi-bot",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: false,
      target: "alice",
      rawTarget: "activi-bot",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        target: "activi-bot",
        senderNick: " ",
      }),
    ).toEqual({
      isGroup: false,
      target: "activi-bot",
      rawTarget: "activi-bot",
    });
  });
});
