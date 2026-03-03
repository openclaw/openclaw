import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageIrcMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageIrc: sendMessageIrcMock,
}));

import { ircPlugin } from "./channel.js";

describe("ircPlugin outbound cfg forwarding", () => {
  beforeEach(() => {
    sendMessageIrcMock.mockReset();
    sendMessageIrcMock.mockResolvedValue({
      messageId: "irc-msg-1",
      target: "#general",
    });
  });

  it("forwards cfg to sendText adapter path", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        irc: {
          enabled: true,
          host: "irc.example.com",
          nick: "openclaw",
          password: "resolved-secret",
        },
      },
    };

    await ircPlugin.outbound?.sendText?.({
      cfg,
      to: "#general",
      text: "hello",
      accountId: "default",
    });

    expect(sendMessageIrcMock).toHaveBeenCalledWith(
      "#general",
      "hello",
      expect.objectContaining({
        cfg,
        accountId: "default",
      }),
    );
  });

  it("forwards cfg to sendMedia adapter path", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        irc: {
          enabled: true,
          host: "irc.example.com",
          nick: "openclaw",
          password: "resolved-secret",
        },
      },
    };

    await ircPlugin.outbound?.sendMedia?.({
      cfg,
      to: "#general",
      text: "hello",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
    });

    expect(sendMessageIrcMock).toHaveBeenCalledWith(
      "#general",
      expect.stringContaining("Attachment: https://example.com/image.png"),
      expect.objectContaining({
        cfg,
        accountId: "default",
      }),
    );
  });
});
