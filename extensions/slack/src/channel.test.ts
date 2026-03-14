import type { OpenClawConfig } from "openclaw/plugin-sdk/slack";
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

import { slackPlugin, mapOutboundIdentityToSlack } from "./channel.js";

describe("slackPlugin actions", () => {
  it("prefers session lookup for announce target routing", () => {
    expect(slackPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });

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

  it("forwards mediaLocalRoots for sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-media-local" });
    const sendMedia = slackPlugin.outbound?.sendMedia;
    expect(sendMedia).toBeDefined();
    const mediaLocalRoots = ["/tmp/workspace"];

    const result = await sendMedia!({
      cfg,
      to: "C999",
      text: "caption",
      mediaUrl: "/tmp/workspace/image.png",
      mediaLocalRoots,
      accountId: "default",
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C999",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/image.png",
        mediaLocalRoots,
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-media-local" });
  });
});

describe("slackPlugin config", () => {
  it("treats HTTP mode accounts with bot token + signing secret as configured", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: "secret-http", // pragma: allowlist secret
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

  it("does not mark partial configured-unavailable token status as configured", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: false,
        botTokenStatus: "configured_unavailable",
        appTokenStatus: "missing",
        botTokenSource: "config",
        appTokenSource: "none",
        config: {},
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(snapshot?.botTokenStatus).toBe("configured_unavailable");
    expect(snapshot?.appTokenStatus).toBe("missing");
  });

  it("keeps HTTP mode signing-secret unavailable accounts configured in snapshots", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: true,
        mode: "http",
        botTokenStatus: "available",
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
        botTokenSource: "config",
        signingSecretSource: "config", // pragma: allowlist secret
        config: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
        },
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(true);
    expect(snapshot?.botTokenStatus).toBe("available");
    expect(snapshot?.signingSecretStatus).toBe("configured_unavailable");
  });
});

describe("mapOutboundIdentityToSlack", () => {
  it("returns undefined for undefined identity", () => {
    expect(mapOutboundIdentityToSlack(undefined)).toBeUndefined();
  });

  it("returns undefined for empty identity object", () => {
    expect(mapOutboundIdentityToSlack({})).toBeUndefined();
  });

  it("returns undefined for whitespace-only fields", () => {
    expect(mapOutboundIdentityToSlack({ name: "  ", emoji: "  " })).toBeUndefined();
  });

  it("maps name to username", () => {
    expect(mapOutboundIdentityToSlack({ name: "Levy" })).toEqual({
      username: "Levy",
      iconUrl: undefined,
      iconEmoji: undefined,
    });
  });

  it("trims name whitespace", () => {
    expect(mapOutboundIdentityToSlack({ name: "  Levy  " })).toEqual({
      username: "Levy",
      iconUrl: undefined,
      iconEmoji: undefined,
    });
  });

  it("maps avatarUrl to iconUrl", () => {
    expect(mapOutboundIdentityToSlack({ avatarUrl: "https://example.com/avatar.png" })).toEqual({
      username: undefined,
      iconUrl: "https://example.com/avatar.png",
      iconEmoji: undefined,
    });
  });

  it("maps colon-wrapped emoji to iconEmoji", () => {
    expect(mapOutboundIdentityToSlack({ emoji: ":robot_face:" })).toEqual({
      username: undefined,
      iconUrl: undefined,
      iconEmoji: ":robot_face:",
    });
  });

  it("ignores emoji without colon wrapping", () => {
    expect(mapOutboundIdentityToSlack({ emoji: "🤖" })).toBeUndefined();
  });

  it("ignores emoji with spaces inside colons", () => {
    expect(mapOutboundIdentityToSlack({ emoji: ":robot face:" })).toBeUndefined();
  });

  it("prefers avatarUrl over emoji when both present", () => {
    expect(
      mapOutboundIdentityToSlack({
        name: "Bot",
        avatarUrl: "https://example.com/avatar.png",
        emoji: ":robot_face:",
      }),
    ).toEqual({
      username: "Bot",
      iconUrl: "https://example.com/avatar.png",
      iconEmoji: undefined,
    });
  });

  it("uses emoji when avatarUrl is absent", () => {
    expect(
      mapOutboundIdentityToSlack({
        name: "Bot",
        emoji: ":robot_face:",
      }),
    ).toEqual({
      username: "Bot",
      iconUrl: undefined,
      iconEmoji: ":robot_face:",
    });
  });
});

describe("slackPlugin outbound identity forwarding", () => {
  const cfg = {
    channels: {
      slack: {
        botToken: "xoxb-test",
        appToken: "xapp-test",
      },
    },
  };

  it("forwards identity as Slack identity fields in sendText", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-id" });
    const sendText = slackPlugin.outbound?.sendText;

    await sendText!({
      cfg,
      to: "C123",
      text: "hello",
      accountId: "default",
      identity: { name: "Levy", emoji: ":tophat:" },
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C123",
      "hello",
      expect.objectContaining({
        identity: { username: "Levy", iconUrl: undefined, iconEmoji: ":tophat:" },
      }),
    );
  });

  it("forwards identity as Slack identity fields in sendMedia", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-id" });
    const sendMedia = slackPlugin.outbound?.sendMedia;

    await sendMedia!({
      cfg,
      to: "C123",
      text: "caption",
      mediaUrl: "https://example.com/img.png",
      accountId: "default",
      identity: { name: "Byte", avatarUrl: "https://example.com/byte.png" },
      deps: { sendSlack },
    });

    expect(sendSlack).toHaveBeenCalledWith(
      "C123",
      "caption",
      expect.objectContaining({
        identity: {
          username: "Byte",
          iconUrl: "https://example.com/byte.png",
          iconEmoji: undefined,
        },
      }),
    );
  });

  it("does not include identity key when identity is undefined", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-id" });
    const sendText = slackPlugin.outbound?.sendText;

    await sendText!({
      cfg,
      to: "C123",
      text: "no identity",
      accountId: "default",
      deps: { sendSlack },
    });

    const callArgs = sendSlack.mock.calls[0][2];
    expect(callArgs).not.toHaveProperty("identity");
  });
});
