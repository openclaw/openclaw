import { createBrokerReceipt } from "openclaw/plugin-sdk/channel-broker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelBrokerPlugin } from "./channel.js";
import { resetChannelBrokerRuntimeForTest, setChannelBrokerRuntime } from "./runtime.js";

describe("channel-broker plugin", () => {
  beforeEach(() => {
    resetChannelBrokerRuntimeForTest();
  });

  it("declares one generic channel owned by provider capabilities", () => {
    expect(channelBrokerPlugin.id).toBe("channel-broker");
    expect(channelBrokerPlugin.message?.receive).toEqual({
      defaultAckPolicy: "after_durable_send",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch", "after_durable_send"],
    });
    expect(channelBrokerPlugin.message?.live?.capabilities).toEqual({
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
    });
  });

  it("delivers text through the configured provider and maps the provider receipt", async () => {
    const controller = new AbortController();
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-send-1",
        providerId: "acme",
        platform: "Telegram",
        status: "sent",
        messageIds: ["native-1"],
        editToken: "edit-native-1",
      }),
    );
    setChannelBrokerRuntime({ sendOutboundRequest, createRequestId: () => "broker-send-1" });

    const cfg = {
      channels: {
        "channel-broker": {
          defaultProviderId: "acme",
          accounts: {
            acme: {
              enabled: true,
              baseUrl: "https://broker.example.test",
              platforms: ["telegram", "discord"],
            },
          },
        },
      },
    };

    const result = await channelBrokerPlugin.message?.send?.text?.({
      cfg,
      to: "telegram:chat%20123?threadId=topic%2Fa",
      text: "hello",
      accountId: "acme",
      replyToId: "native-parent",
      threadId: "topic/a",
      signal: controller.signal,
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      signal: controller.signal,
      request: {
        version: 1,
        requestId: "broker-send-1",
        providerId: "acme",
        platform: "telegram",
        accountId: "acme",
        conversation: {
          id: "chat 123",
          type: "channel",
          threadId: "topic/a",
        },
        mode: "final",
        payloads: [{ text: "hello" }],
        relation: { replyToId: "native-parent" },
        requirements: { text: true, replyTo: true, thread: true },
      },
    });
    expect(result?.messageId).toBe("native-1");
    expect(result?.receipt).toEqual({
      primaryPlatformMessageId: "native-1",
      platformMessageIds: ["native-1"],
      parts: [
        {
          platformMessageId: "native-1",
          kind: "text",
          index: 0,
          threadId: "topic/a",
          replyToId: "native-parent",
          raw: {
            channel: "channel-broker",
            messageId: "native-1",
            conversationId: "chat 123",
            timestamp: expect.any(Number),
            meta: {
              providerId: "acme",
              platform: "telegram",
              status: "sent",
              requestId: "broker-send-1",
            },
          },
        },
      ],
      threadId: "topic/a",
      replyToId: "native-parent",
      editToken: "edit-native-1",
      sentAt: expect.any(Number),
      raw: [
        {
          channel: "channel-broker",
          messageId: "native-1",
          conversationId: "chat 123",
          timestamp: expect.any(Number),
          meta: {
            providerId: "acme",
            platform: "telegram",
            status: "sent",
            requestId: "broker-send-1",
          },
        },
      ],
    });
  });

  it("maps broker-prefixed Telegram topics into provider thread requests", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-telegram-topic-1",
        providerId: "acme",
        platform: "Telegram",
        status: "sent",
        messageIds: ["telegram-message-1"],
      }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-telegram-topic-1",
    });

    await channelBrokerPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          "channel-broker": {
            defaultProviderId: "acme",
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["telegram"],
              },
            },
          },
        },
      },
      to: "broker:telegram:-1001234567890:topic:42",
      text: "topic proof",
      accountId: "acme",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        requestId: "broker-telegram-topic-1",
        providerId: "acme",
        platform: "telegram",
        conversation: {
          id: "-1001234567890",
          type: "channel",
          threadId: "42",
        },
        requirements: { text: true, thread: true },
      }),
    });
  });

  it("canonicalizes Telegram topic routes without changing native default ownership", () => {
    const route = channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["telegram"],
              },
            },
          },
        },
      },
      agentId: "agent",
      accountId: "acme",
      target: "broker:telegram:-1001234567890:topic:42",
    } as never);

    expect(route).toMatchObject({
      chatType: "channel",
      peer: { kind: "channel", id: "telegram:-1001234567890" },
      to: "telegram:-1001234567890?threadId=42",
      threadId: "42",
    });
  });

  it("maps broker-prefixed Discord DMs into direct provider requests", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-discord-dm-1",
        providerId: "acme",
        platform: "Discord",
        status: "sent",
        messageIds: ["discord-message-1"],
      }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-discord-dm-1",
    });

    await channelBrokerPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["discord"],
              },
            },
          },
        },
      },
      to: "broker:discord:user:123456789012345678",
      text: "dm proof",
      accountId: "acme",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        requestId: "broker-discord-dm-1",
        providerId: "acme",
        platform: "discord",
        conversation: {
          id: "123456789012345678",
          type: "direct",
        },
        requirements: { text: true },
      }),
    });
  });

  it("maps broker-prefixed Discord channel threads into provider thread requests", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-discord-thread-1",
        providerId: "acme",
        platform: "Discord",
        status: "sent",
        messageIds: ["discord-message-2"],
      }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-discord-thread-1",
    });

    await channelBrokerPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["discord"],
              },
            },
          },
        },
      },
      to: "broker:discord:channel:222222222222222222?threadId=333333333333333333",
      text: "thread proof",
      accountId: "acme",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        requestId: "broker-discord-thread-1",
        providerId: "acme",
        platform: "discord",
        conversation: {
          id: "222222222222222222",
          type: "channel",
          threadId: "333333333333333333",
        },
        requirements: { text: true, thread: true },
      }),
    });
  });

  it("canonicalizes Discord DM routes with direct conversation type preserved", () => {
    const route = channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["discord"],
              },
            },
          },
        },
      },
      agentId: "agent",
      accountId: "acme",
      target: "broker:discord:user:123456789012345678",
    } as never);

    expect(route).toMatchObject({
      chatType: "direct",
      peer: { kind: "direct", id: "discord:123456789012345678" },
      to: "discord:direct%3A123456789012345678",
    });
  });

  it("maps broker-prefixed Slack DMs into direct provider requests", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-slack-dm-1",
        providerId: "acme",
        platform: "Slack",
        status: "sent",
        messageIds: ["slack-message-1"],
      }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-slack-dm-1",
    });

    await channelBrokerPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["slack"],
              },
            },
          },
        },
      },
      to: "broker:slack:user:U12345678",
      text: "dm proof",
      accountId: "acme",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        requestId: "broker-slack-dm-1",
        providerId: "acme",
        platform: "slack",
        conversation: {
          id: "U12345678",
          type: "direct",
        },
        requirements: { text: true },
      }),
    });
  });

  it("maps broker-prefixed Slack channel threads into provider thread requests", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-slack-thread-1",
        providerId: "acme",
        platform: "Slack",
        status: "sent",
        messageIds: ["slack-message-2"],
      }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-slack-thread-1",
    });

    await channelBrokerPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["slack"],
              },
            },
          },
        },
      },
      to: "broker:slack:channel:C12345678?threadId=1716500000.000001",
      text: "thread proof",
      accountId: "acme",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        requestId: "broker-slack-thread-1",
        providerId: "acme",
        platform: "slack",
        conversation: {
          id: "C12345678",
          type: "channel",
          threadId: "1716500000.000001",
        },
        requirements: { text: true, thread: true },
      }),
    });
  });

  it("canonicalizes Slack DM and thread routes with native target semantics preserved", () => {
    const cfg = {
      channels: {
        "channel-broker": {
          accounts: {
            acme: {
              enabled: true,
              baseUrl: "https://broker.example.test",
              platforms: ["slack"],
            },
          },
        },
      },
    };

    const dmRoute = channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg,
      agentId: "agent",
      accountId: "acme",
      target: "broker:slack:user:U12345678",
    } as never);
    const threadRoute = channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg,
      agentId: "agent",
      accountId: "acme",
      target: "broker:slack:channel:C12345678?threadId=1716500000.000001",
    } as never);

    expect(dmRoute).toMatchObject({
      chatType: "direct",
      peer: { kind: "direct", id: "slack:U12345678" },
      to: "slack:direct%3AU12345678",
    });
    expect(threadRoute).toMatchObject({
      chatType: "channel",
      peer: { kind: "channel", id: "slack:C12345678" },
      to: "slack:C12345678?threadId=1716500000.000001",
      threadId: "1716500000.000001",
    });
  });

  it.each([
    {
      label: "Microsoft Teams alias",
      target: "broker:teams:19:meeting-channel",
      platform: "microsoft-teams",
      id: "19:meeting-channel",
      type: "channel",
    },
    {
      label: "Google Chat alias",
      target: "broker:googlechat:spaces/AAA?threadId=thread-1",
      platform: "google-chat",
      id: "spaces/AAA",
      type: "channel",
      threadId: "thread-1",
    },
    {
      label: "Matrix room",
      target: "broker:matrix:!roomid:example.org",
      platform: "matrix",
      id: "!roomid:example.org",
      type: "channel",
    },
    {
      label: "LINE group",
      target: "broker:line:group:line-room",
      platform: "line",
      id: "line-room",
      type: "group",
    },
    {
      label: "Feishu group",
      target: "broker:feishu:group:oc_123",
      platform: "feishu",
      id: "oc_123",
      type: "group",
    },
    {
      label: "QQ bot alias",
      target: "broker:qq:group:123456",
      platform: "qqbot",
      id: "123456",
      type: "group",
    },
    {
      label: "Zalo direct",
      target: "broker:zalo:direct:84901234567",
      platform: "zalo",
      id: "84901234567",
      type: "direct",
    },
    {
      label: "Mattermost channel",
      target: "broker:mattermost:channel:team/channel",
      platform: "mattermost",
      id: "team/channel",
      type: "channel",
    },
    {
      label: "Nextcloud Talk room",
      target: "broker:nextcloud-talk:channel:token-1",
      platform: "nextcloud-talk",
      id: "token-1",
      type: "channel",
    },
    {
      label: "Twitch channel",
      target: "broker:twitch:channel:openclawdev",
      platform: "twitch",
      id: "openclawdev",
      type: "channel",
    },
    {
      label: "IRC channel",
      target: "broker:irc:channel:%23openclaw",
      platform: "irc",
      id: "#openclaw",
      type: "channel",
    },
    {
      label: "Nostr direct",
      target: "broker:nostr:direct:npub1openclaw",
      platform: "nostr",
      id: "npub1openclaw",
      type: "direct",
    },
    {
      label: "Tlon channel",
      target: "broker:tlon:channel:~zod/test",
      platform: "tlon",
      id: "~zod/test",
      type: "channel",
    },
    {
      label: "Synology Chat channel",
      target: "broker:synology-chat:channel:42",
      platform: "synology-chat",
      id: "42",
      type: "channel",
    },
  ] as const)(
    "maps broker-prefixed Phase 3 platform target: $label",
    async ({ target, platform, id, type, threadId }) => {
      const sendOutboundRequest = vi.fn(async () =>
        createBrokerReceipt({
          requestId: `broker-phase3-${platform}`,
          providerId: "acme",
          platform,
          status: "sent",
          messageIds: [`${platform}-message-1`],
        }),
      );
      setChannelBrokerRuntime({
        sendOutboundRequest,
        createRequestId: () => `broker-phase3-${platform}`,
      });

      await channelBrokerPlugin.message?.send?.text?.({
        cfg: {
          channels: {
            "channel-broker": {
              accounts: {
                acme: {
                  enabled: true,
                  baseUrl: "https://broker.example.test",
                  platforms: [platform],
                },
              },
            },
          },
        },
        to: target,
        text: "phase 3 proof",
        accountId: "acme",
      } as never);

      expect(sendOutboundRequest).toHaveBeenCalledWith({
        account: expect.objectContaining({ providerId: "acme" }),
        request: expect.objectContaining({
          requestId: `broker-phase3-${platform}`,
          providerId: "acme",
          platform,
          conversation: {
            id,
            type,
            ...(threadId ? { threadId } : {}),
          },
          requirements: {
            text: true,
            ...(threadId ? { thread: true } : {}),
          },
        }),
      });
    },
  );

  it("passes cancellation through the default HTTP transport", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () =>
        createBrokerReceipt({
          requestId: "broker-send-2",
          providerId: "acme",
          platform: "Slack",
          status: "sent",
          messageIds: ["native-2"],
        }),
    }));
    setChannelBrokerRuntime({ fetch: fetchMock as never, createRequestId: () => "broker-send-2" });

    const result = await channelBrokerPlugin.message?.send?.text?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test/",
                outboundToken: "resolved-token",
              },
            },
          },
        },
      },
      to: "slack:C123",
      text: "hello",
      accountId: "acme",
      signal: controller.signal,
    } as never);

    expect(result?.messageId).toBe("native-2");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://broker.example.test/v1/outbound",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        headers: expect.objectContaining({ authorization: "Bearer resolved-token" }),
      }),
    );
  });
});
