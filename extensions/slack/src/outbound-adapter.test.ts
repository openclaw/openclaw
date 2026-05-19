import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMessageSlackMock(...args),
}));

let slackOutbound: typeof import("./outbound-adapter.js").slackOutbound;
({ slackOutbound } = await import("./outbound-adapter.js"));

describe("slackOutbound", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  beforeEach(() => {
    sendMessageSlackMock.mockReset();
  });

  it("sends payload media first, then finalizes with blocks", async () => {
    sendMessageSlackMock
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "final text",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        presentation: {
          blocks: [
            {
              type: "text",
              text: "Block body",
            },
          ],
        },
      },
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledTimes(3);
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(1, "C123", "", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      mediaUrl: "https://example.com/1.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile: undefined,
    });
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(2, "C123", "", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      mediaUrl: "https://example.com/2.png",
      mediaAccess: undefined,
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile: undefined,
    });
    expect(sendMessageSlackMock).toHaveBeenNthCalledWith(3, "C123", "final text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Block body" },
        },
      ],
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });

  it("renders channelData Slack blocks on payload sends", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    const result = await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      blocks: [{ type: "divider" }],
    });
    expect(result).toEqual({ channel: "slack", messageId: "m-blocks" });
  });

  it("falls back to threadId when payload replyToId is not a Slack thread timestamp", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      replyToId: "msg-internal-1",
      threadId: "1712345678.123456",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: "1712345678.123456",
      accountId: "default",
      blocks: [{ type: "divider" }],
    });
  });

  it("does not thread payloads without a valid Slack thread timestamp", async () => {
    sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-blocks" });

    await slackOutbound.sendPayload!({
      cfg,
      to: "C123",
      text: "",
      replyToId: "msg-internal-1",
      threadId: "thread-root",
      payload: {
        text: "fallback text",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
      accountId: "default",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith("C123", "fallback text", {
      cfg,
      threadTs: undefined,
      accountId: "default",
      blocks: [{ type: "divider" }],
    });
  });

  // Issue #84297: per-agent identity overlay must reach sendMessageSlack on the
  // outbound-adapter path, including the case where `agents.list[].identity.emoji`
  // is configured as a raw Unicode emoji (e.g. "📟") rather than a Slack shortcode.
  // The reply path at src/monitor/message-handler/dispatch.ts already passes the
  // raw value through, so this lock-in keeps the announce/heartbeat path consistent.
  describe("identity overlay (issue #84297)", () => {
    it("forwards a raw Unicode emoji into iconEmoji on sendText", async () => {
      sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-text" });

      await slackOutbound.sendText!({
        cfg,
        to: "C123",
        text: "status",
        accountId: "default",
        identity: { name: "Pulse", emoji: "📟" },
      });

      expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
      const opts = sendMessageSlackMock.mock.calls[0]?.[2] as
        | { identity?: { username?: string; iconEmoji?: string; iconUrl?: string } }
        | undefined;
      expect(opts?.identity).toEqual({
        username: "Pulse",
        iconUrl: undefined,
        iconEmoji: "📟",
      });
    });

    it("still accepts the :shortcode: form for callers that set it explicitly", async () => {
      sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-shortcode" });

      await slackOutbound.sendText!({
        cfg,
        to: "C123",
        text: "status",
        accountId: "default",
        identity: { name: "Pulse", emoji: ":beeper:" },
      });

      const opts = sendMessageSlackMock.mock.calls[0]?.[2] as
        | { identity?: { iconEmoji?: string } }
        | undefined;
      expect(opts?.identity?.iconEmoji).toBe(":beeper:");
    });

    it("prefers iconUrl over emoji when both are configured (Slack API exclusivity)", async () => {
      sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-url" });

      await slackOutbound.sendText!({
        cfg,
        to: "C123",
        text: "status",
        accountId: "default",
        identity: {
          name: "Pulse",
          emoji: "📟",
          avatarUrl: "https://example.invalid/avatar.png",
        },
      });

      const opts = sendMessageSlackMock.mock.calls[0]?.[2] as
        | { identity?: { iconUrl?: string; iconEmoji?: string } }
        | undefined;
      expect(opts?.identity?.iconUrl).toBe("https://example.invalid/avatar.png");
      expect(opts?.identity?.iconEmoji).toBeUndefined();
    });

    it("omits identity entirely when no fields are configured", async () => {
      sendMessageSlackMock.mockResolvedValueOnce({ messageId: "m-no-identity" });

      await slackOutbound.sendText!({
        cfg,
        to: "C123",
        text: "status",
        accountId: "default",
      });

      const opts = sendMessageSlackMock.mock.calls[0]?.[2] as { identity?: unknown } | undefined;
      expect(opts?.identity).toBeUndefined();
    });
  });
});
