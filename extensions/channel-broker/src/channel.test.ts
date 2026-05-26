import { createBrokerReceipt } from "openclaw/plugin-sdk/channel-broker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import channelBrokerEntry from "../index.js";
import { channelBrokerPlugin } from "./channel.js";
import { resetChannelBrokerRuntimeForTest, setChannelBrokerRuntime } from "./runtime.js";

describe("channel-broker plugin", () => {
  beforeEach(() => {
    resetChannelBrokerRuntimeForTest();
  });

  it("declares one generic channel owned by provider capabilities", () => {
    expect(channelBrokerPlugin.id).toBe("channel-broker");
    expect(channelBrokerPlugin.message?.durableFinal?.capabilities).toMatchObject({
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    });
    expect(channelBrokerPlugin.capabilities).toMatchObject({
      media: true,
      reply: true,
      threads: true,
    });
    expect(channelBrokerPlugin.capabilities).not.toMatchObject({
      reactions: true,
      edit: true,
    });
    expect(channelBrokerPlugin.message?.durableFinal?.capabilities).not.toMatchObject({
      reconcileUnknownSend: true,
      afterCommit: true,
    });
    expect(channelBrokerPlugin.message?.receive).toEqual({
      defaultAckPolicy: "after_durable_send",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch", "after_durable_send"],
    });
    expect(channelBrokerPlugin.message?.live).toBeUndefined();
  });

  it("exposes the bundled runtime setter declared by the channel entry", () => {
    expect(() => channelBrokerEntry.setChannelRuntime?.({} as never)).not.toThrow();
  });

  it("infers broker-prefixed platform DMs before defaulting to channel semantics", () => {
    expect(
      channelBrokerPlugin.messaging?.inferTargetChatType?.({
        to: "broker:slack:user:U12345678",
      } as never),
    ).toBe("direct");
    expect(
      channelBrokerPlugin.messaging?.inferTargetChatType?.({
        to: "broker:discord:dm:123456789012345678",
      } as never),
    ).toBe("direct");
  });

  it("delivers broker-prefixed DM aliases as direct conversations", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-dm-1",
        providerId: "acme",
        platform: "Slack",
        status: "sent",
        messageIds: ["native-dm-1"],
      }),
    );
    setChannelBrokerRuntime({ sendOutboundRequest, createRequestId: () => "broker-dm-1" });

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
      text: "hello",
      accountId: "acme",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        platform: "slack",
        conversation: {
          id: "U12345678",
          type: "direct",
        },
      }),
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

  it("delivers media through the configured provider without dropping attachments", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-media-1",
        providerId: "acme",
        platform: "Slack",
        status: "sent",
        messageIds: ["native-media-1"],
      }),
    );
    setChannelBrokerRuntime({ sendOutboundRequest, createRequestId: () => "broker-media-1" });

    const result = await channelBrokerPlugin.message?.send?.media?.({
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
      to: "slack:C123",
      text: "see attached",
      mediaUrl: "https://cdn.example.test/image.png",
      accountId: "acme",
      threadId: "1716500000.000001",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        requestId: "broker-media-1",
        platform: "slack",
        conversation: {
          id: "C123",
          type: "channel",
          threadId: "1716500000.000001",
        },
        mode: "final",
        payloads: [
          {
            text: "see attached",
            attachments: [{ url: "https://cdn.example.test/image.png", mediaType: "media" }],
          },
        ],
        requirements: { media: true, text: true, thread: true },
      }),
    });
    expect(result?.receipt.parts[0]?.kind).toBe("media");
  });

  it("rejects non-sent provider receipts before reporting send success", async () => {
    setChannelBrokerRuntime({
      createRequestId: () => "broker-send-retryable",
      sendOutboundRequest: vi.fn(async () =>
        createBrokerReceipt({
          requestId: "broker-send-retryable",
          providerId: "acme",
          platform: "Telegram",
          status: "retryable",
          messageIds: ["native-should-not-commit"],
          retryAfterMs: 2500,
          error: { code: "rate_limited", message: "rate limited", retryable: true },
        }),
      ),
    });

    await expect(
      channelBrokerPlugin.message?.send?.text?.({
        cfg: {
          channels: {
            "channel-broker": {
              accounts: {
                acme: {
                  enabled: true,
                  baseUrl: "https://broker.example.test",
                },
              },
            },
          },
        },
        to: "telegram:chat-1",
        text: "hello",
        accountId: "acme",
      } as never),
    ).rejects.toMatchObject({
      name: "ChannelBrokerProviderReceiptError",
      receipt: { status: "retryable", retryAfterMs: 2500 },
    });
  });

  it("rejects provider receipts that do not match the outbound request", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "stale-request",
        providerId: "acme",
        platform: "Telegram",
        status: "sent",
        messageIds: ["native-stale"],
      }),
    );
    setChannelBrokerRuntime({
      createRequestId: () => "broker-send-current",
      sendOutboundRequest,
    });

    await expect(
      channelBrokerPlugin.message?.send?.text?.({
        cfg: {
          channels: {
            "channel-broker": {
              accounts: {
                acme: {
                  enabled: true,
                  baseUrl: "https://broker.example.test",
                },
              },
            },
          },
        },
        to: "telegram:chat-1",
        text: "hello",
        accountId: "acme",
      } as never),
    ).rejects.toThrow(
      "Channel broker provider acme returned receipt for request stale-request while OpenClaw expected broker-send-current.",
    );
    expect(sendOutboundRequest).toHaveBeenCalledOnce();
  });

  it("rejects targets outside a provider's configured platform set", () => {
    const result = channelBrokerPlugin.outbound?.resolveTarget?.({
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
      accountId: "acme",
      to: "broker:slack:C123",
    } as never);

    expect(result).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: "Invalid channel broker target: broker:slack:C123",
        cause: expect.objectContaining({
          message: "Channel broker provider acme does not support platform slack.",
        }),
      }),
    });
  });

  it("rejects sends that exceed declared provider delivery capabilities", async () => {
    const sendOutboundRequest = vi.fn();
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-capability-reject-1",
    });

    await expect(
      channelBrokerPlugin.message?.send?.text?.({
        cfg: {
          channels: {
            "channel-broker": {
              accounts: {
                acme: {
                  enabled: true,
                  baseUrl: "https://broker.example.test",
                  platforms: ["slack"],
                  capabilities: {
                    slack: {
                      delivery: { text: true },
                    },
                  },
                },
              },
            },
          },
        },
        to: "broker:slack:C123?threadId=1716500000.000001",
        text: "thread proof",
        accountId: "acme",
      } as never),
    ).rejects.toThrow(
      "Channel broker provider acme does not support slack delivery requirements: thread.",
    );
    expect(sendOutboundRequest).not.toHaveBeenCalled();
  });

  it("allows outbound sends when capability metadata does not constrain delivery", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-capability-metadata-1",
        providerId: "acme",
        platform: "Slack",
        status: "sent",
        messageIds: ["native-metadata-1"],
      }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-capability-metadata-1",
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
                capabilities: {
                  slack: {
                    receive: { webhook: true },
                    native: { botApi: true },
                  },
                },
              },
            },
          },
        },
      },
      to: "broker:slack:C123",
      text: "metadata only",
      accountId: "acme",
    } as never);

    expect(sendOutboundRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          platform: "slack",
          payloads: [expect.objectContaining({ text: "metadata only" })],
        }),
      }),
    );
  });

  it("rejects invalid broker targets during outbound resolution", () => {
    const result = channelBrokerPlugin.outbound?.resolveTarget?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
              },
            },
          },
        },
      },
      accountId: "acme",
      to: "not-a-broker-target",
    } as never);

    expect(result).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: "Invalid channel broker target: not-a-broker-target",
      }),
    });
  });

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
