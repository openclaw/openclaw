import { describe, expect, it } from "vitest";
import { resolveIrcInboundTarget } from "./monitor.js";

describe("irc monitor inbound target", () => {
  it("keeps channel target for group messages", () => {
    expect(
      resolveIrcInboundTarget({
        target: "#mullusi",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: true,
      target: "#mullusi",
      rawTarget: "#mullusi",
    });
  });

  it("maps DM target to sender nick and preserves raw target", () => {
    expect(
      resolveIrcInboundTarget({
        target: "mullusi-bot",
        senderNick: "alice",
      }),
    ).toEqual({
      isGroup: false,
      target: "alice",
      rawTarget: "mullusi-bot",
    });
  });

  it("falls back to raw target when sender nick is empty", () => {
    expect(
      resolveIrcInboundTarget({
        target: "mullusi-bot",
        senderNick: " ",
      }),
    ).toEqual({
      isGroup: false,
      target: "mullusi-bot",
      rawTarget: "mullusi-bot",
    });
  });
});
