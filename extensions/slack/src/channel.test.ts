import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

const handleSlackActionMock = vi.fn();

vi.mock("./runtime.js", () => ({
  getSlackRuntime: () => ({
    channel: {
      slack: {
        handleSlackAction: handleSlackActionMock,
      },
    },
  }),
}));

import { slackPlugin } from "./channel.js";

describe("slackPlugin actions", () => {
  it("forwards read threadId to Slack action handler", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ messages: [], hasMore: false });
    const handleAction = slackPlugin.actions?.handleAction;
    expect(handleAction).toBeDefined();

    await handleAction!({
      action: "read",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: {
        channelId: "C123",
        threadId: "1712345678.123456",
      },
    });

    expect(handleSlackActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "readMessages",
        channelId: "C123",
        threadId: "1712345678.123456",
      }),
      {},
      undefined,
    );
  });
});

describe("slackPlugin outbound", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  it("uses threadId as threadTs fallback for sendText", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-text" });
    const sendText = slackPlugin.outbound?.sendText;
    expect(sendText).toBeDefined();

    const result = await sendText!({
      cfg,
      to: "C123",
      text: "hello",
      accountId: "default",
      threadId: "1712345678.123456",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C123",
      "hello",
      expect.objectContaining({
        threadTs: "1712345678.123456",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-text" });
  });

  it("prefers replyToId over threadId for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media" });
    const sendMedia = slackPlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();

    const result = await sendMedia!({
      cfg,
      to: "C999",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
      replyToId: "1712000000.000001",
      threadId: "1712345678.123456",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C999",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/image.png",
        threadTs: "1712000000.000001",
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-media" });
  });
});

describe("slackPlugin config", () => {
  it("treats HTTP mode accounts with bot token + signing secret as configured", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: "secret-http",
        },
      },
    };

    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const configured = slackPlugin.config.isConfigured?.(account, cfg);
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: undefined,
    });

    expect(configured).toBe(true);
    expect(snapshot?.configured).toBe(true);
  });

  it("keeps socket mode requiring app token", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          mode: "socket",
          botToken: "xoxb-socket",
        },
      },
    };

    const account = slackPlugin.config.resolveAccount(cfg, "default");
    const configured = slackPlugin.config.isConfigured?.(account, cfg);
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: undefined,
    });

    expect(configured).toBe(false);
    expect(snapshot?.configured).toBe(false);
  });
});
