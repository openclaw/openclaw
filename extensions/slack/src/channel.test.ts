import type { OpenClawConfig } from "openclaw/plugin-sdk/slack";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import { slackOutbound } from "./outbound-adapter.js";

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

async function getSlackConfiguredState(cfg: OpenClawConfig) {
  const account = slackPlugin.config.resolveAccount(cfg, "default");
  return {
    configured: slackPlugin.config.isConfigured?.(account, cfg),
    snapshot: await slackPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: undefined,
    }),
  };
}

describe("slackPlugin actions", () => {
  it("prefers session lookup for announce target routing", () => {
    expect(slackPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });

  it("owns unified message tool discovery", () => {
    const discovery = slackPlugin.actions?.describeMessageTool({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.capabilities).toEqual(expect.arrayContaining(["blocks", "interactive"]));
    expect(discovery?.schema).toMatchObject({
      properties: {
        blocks: expect.any(Object),
      },
    });
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

  it("sends block payload media first, then the final block message", async () => {
    const sendSlack = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "m-media-1" })
      .mockResolvedValueOnce({ messageId: "m-media-2" })
      .mockResolvedValueOnce({ messageId: "m-final" });
    const sendPayload = slackOutbound.sendPayload;
    expect(sendPayload).toBeDefined();

    const result = await sendPayload!({
      cfg,
      to: "C999",
      text: "",
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        channelData: {
          slack: {
            blocks: [
              {
                type: "section",
                text: {
                  type: "plain_text",
                  text: "Block body",
                },
              },
            ],
          },
        },
      },
      accountId: "default",
      deps: { sendSlack },
      mediaLocalRoots: ["/tmp/media"],
    });

    expect(sendSlack).toHaveBeenCalledTimes(3);
    expect(sendSlack).toHaveBeenNthCalledWith(
      1,
      "C999",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.png",
        mediaLocalRoots: ["/tmp/media"],
      }),
    );
    expect(sendSlack).toHaveBeenNthCalledWith(
      2,
      "C999",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.png",
        mediaLocalRoots: ["/tmp/media"],
      }),
    );
    expect(sendSlack).toHaveBeenNthCalledWith(
      3,
      "C999",
      "hello",
      expect.objectContaining({
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              text: "Block body",
            },
          },
        ],
      }),
    );
    expect(result).toEqual({ channel: "slack", messageId: "m-final" });
  });
});

describe("slackPlugin directory", () => {
  it("lists configured peers without throwing a ReferenceError", async () => {
    const listPeers = slackPlugin.directory?.listPeers;
    expect(listPeers).toBeDefined();

    await expect(
      listPeers!({
        cfg: {
          channels: {
            slack: {
              dms: {
                U123: {},
              },
            },
          },
        },
        runtime: createRuntimeEnv(),
      }),
    ).resolves.toEqual([{ id: "user:u123", kind: "user" }]);
  });
});

describe("slackPlugin agentPrompt", () => {
  it("tells agents interactive replies are disabled by default", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
        },
      },
    });

    expect(hints).toEqual([
      "- Slack interactive replies are disabled. If needed, ask to set `channels.slack.capabilities.interactiveReplies=true` (or the same under `channels.slack.accounts.<account>.capabilities`).",
    ]);
  });

  it("shows Slack interactive reply directives when enabled", () => {
    const hints = slackPlugin.agentPrompt?.messageToolHints?.({
      cfg: {
        channels: {
          slack: {
            botToken: "xoxb-test",
            appToken: "xapp-test",
            capabilities: { interactiveReplies: true },
          },
        },
      },
    });

    expect(hints).toContain(
      "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
    );
    expect(hints).toContain(
      "- Slack selects: use `[[slack_select: Placeholder | Label:value, Other:other]]` to add a static select menu that routes the chosen value back as a Slack interaction system event.",
    );
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

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

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

    const { configured, snapshot } = await getSlackConfiguredState(cfg);

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
