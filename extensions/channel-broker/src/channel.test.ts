import { createBrokerReceipt } from "openclaw/plugin-sdk/channel-broker";
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";
import channelBrokerEntry from "../index.js";
import { channelBrokerPlugin } from "./channel.js";
import {
  resetChannelBrokerRuntimeForTest,
  setChannelBrokerRuntime,
  type ChannelBrokerRuntime,
} from "./runtime.js";

function requireChannelBrokerMessageAdapter(): NonNullable<typeof channelBrokerPlugin.message> {
  const adapter = channelBrokerPlugin.message;
  if (!adapter) {
    throw new Error("channel-broker message adapter is required for this test");
  }
  return adapter;
}

describe("channel-broker plugin", () => {
  beforeEach(() => {
    resetChannelBrokerRuntimeForTest();
  });

  it("declares one generic channel owned by provider capabilities", () => {
    expect(channelBrokerPlugin.id).toBe("channel-broker");
    expect(channelBrokerPlugin.message?.durableFinal?.capabilities).toMatchObject({
      text: true,
      media: true,
      payload: true,
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
    expect(channelBrokerPlugin.message?.live).toMatchObject({
      capabilities: {
        draftPreview: true,
        previewFinalization: true,
        progressUpdates: true,
      },
      finalizer: {
        capabilities: {
          normalFallback: true,
          previewReceipt: true,
        },
      },
    });
  });

  it("exposes the bundled runtime setter declared by the channel entry", () => {
    expect(channelBrokerEntry.setChannelRuntime).toBeTypeOf("function");
    expect(() => setChannelBrokerRuntime({} as never)).not.toThrow();
  });

  it("backs declared durable final capabilities with send adapter proofs", async () => {
    const adapter = requireChannelBrokerMessageAdapter();

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "channelBrokerMessageAdapter",
      adapter,
      proofs: {
        text: () => {
          expect(adapter?.send?.text).toBeTypeOf("function");
        },
        media: () => {
          expect(adapter?.send?.media).toBeTypeOf("function");
        },
        payload: () => {
          expect(adapter?.send?.payload).toBeTypeOf("function");
        },
        replyTo: () => {
          expect(adapter?.durableFinal?.capabilities?.replyTo).toBe(true);
        },
        thread: () => {
          expect(adapter?.durableFinal?.capabilities?.thread).toBe(true);
        },
        messageSendingHooks: () => {
          expect(adapter?.send?.text).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared live capabilities with provider-mode proofs", async () => {
    const adapter = requireChannelBrokerMessageAdapter();

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "channelBrokerMessageAdapter",
      adapter,
      proofs: {
        draftPreview: () => {
          expect(adapter?.receive?.defaultAckPolicy).toBe("after_durable_send");
        },
        previewFinalization: () => {
          expect(adapter?.durableFinal?.capabilities?.payload).toBe(true);
        },
        progressUpdates: () => {
          expect(adapter?.live?.capabilities?.draftPreview).toBe(true);
        },
      },
    });

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "channelBrokerMessageAdapter",
      adapter,
      proofs: {
        normalFallback: () => {
          expect(adapter?.send?.text).toBeTypeOf("function");
        },
        previewReceipt: () => {
          expect(adapter?.live?.capabilities?.previewFinalization).toBe(true);
        },
      },
    });
  });

  it("infers broker-prefixed platform DMs before defaulting to channel semantics", () => {
    expect(
      channelBrokerPlugin.messaging?.inferTargetChatType?.({
        to: "slack:user:U12345678",
      } as never),
    ).toBe("direct");
    expect(
      channelBrokerPlugin.messaging?.inferTargetChatType?.({
        to: "broker:slack:user:U12345678",
      } as never),
    ).toBe("direct");
    expect(
      channelBrokerPlugin.messaging?.inferTargetChatType?.({
        to: "slack:user%3AU12345678",
      } as never),
    ).toBe("channel");
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

  it("resolves broker thread session suffixes against the base conversation", () => {
    expect(
      channelBrokerPlugin.messaging?.resolveSessionConversation?.({
        kind: "channel",
        rawId: "slack:C123:thread:1716500000.000001",
      }),
    ).toEqual({
      id: "slack:C123",
      threadId: "1716500000.000001",
      baseConversationId: "slack:C123",
      parentConversationCandidates: ["slack:C123"],
    });
  });

  it("uses explicit broker thread ids before reply ids for session routes", async () => {
    const route = await channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
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
      agentId: "main",
      accountId: "acme",
      target: "slack:C123?threadId=1716500000.000001",
      replyToId: "native-parent",
    } as never);

    expect(route?.sessionKey).toBe(
      "agent:main:channel-broker:channel:slack:c123:thread:1716500000.000001",
    );
    expect(route?.threadId).toBe("1716500000.000001");
  });

  it("does not persist broker reply ids as session thread routes", async () => {
    const route = await channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
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
      agentId: "main",
      accountId: "acme",
      target: "telegram:chat-1",
      replyToId: "native-parent",
    } as never);

    expect(route?.sessionKey).toBe("agent:main:channel-broker:channel:telegram:chat-1");
    expect(route?.threadId).toBeUndefined();
  });

  it("does not recover broker current-session threads without delivery thread ids", async () => {
    const route = await channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
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
      agentId: "main",
      accountId: "acme",
      target: "slack:C123",
      currentSessionKey: "agent:main:channel-broker:channel:slack:c123:thread:1716500000.000001",
    } as never);

    expect(route?.sessionKey).toBe("agent:main:channel-broker:channel:slack:c123");
    expect(route?.threadId).toBeUndefined();
  });

  it("stores account-default broker targets canonically in session routes", async () => {
    const route = await channelBrokerPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                defaultPlatform: "telegram",
                defaultConversationType: "direct",
              },
            },
          },
        },
      },
      agentId: "main",
      accountId: "acme",
      target: "broker:12345",
    } as never);

    expect(route?.to).toBe("broker:telegram:12345?conversationType=direct");
    expect(route?.chatType).toBe("direct");
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

  it("blocks outbound sends for disabled broker accounts", async () => {
    const sendOutboundRequest = vi.fn();
    setChannelBrokerRuntime({ sendOutboundRequest, createRequestId: () => "broker-send-1" });

    await expect(
      channelBrokerPlugin.message?.send?.text?.({
        cfg: {
          channels: {
            "channel-broker": {
              accounts: {
                acme: {
                  enabled: false,
                  baseUrl: "https://broker.example.test",
                  platforms: ["telegram"],
                },
              },
            },
          },
        },
        to: "telegram:chat-1",
        text: "hello",
        accountId: "acme",
      } as never),
    ).rejects.toThrow("Channel broker provider acme is disabled.");
    expect(sendOutboundRequest).not.toHaveBeenCalled();
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

  it("inlines local media through the outbound media reader instead of leaking host paths", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    const mediaReadFile = vi.fn(async () => png);
    const sendOutboundRequest: NonNullable<ChannelBrokerRuntime["sendOutboundRequest"]> = vi.fn(
      async () =>
        createBrokerReceipt({
          requestId: "broker-local-media-1",
          providerId: "acme",
          platform: "Slack",
          status: "sent",
          messageIds: ["native-local-media-1"],
        }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-local-media-1",
    });

    await channelBrokerPlugin.message?.send?.media?.({
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
      mediaUrl: "file:///private/tmp/openclaw-media/photo.png",
      mediaLocalRoots: ["/private/tmp/openclaw-media"],
      mediaReadFile,
      accountId: "acme",
    } as never);

    expect(mediaReadFile).toHaveBeenCalledWith("/private/tmp/openclaw-media/photo.png");
    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        payloads: [
          {
            text: "see attached",
            attachments: [
              expect.objectContaining({
                mediaType: "media",
                contentBase64: png.toString("base64"),
                mimeType: "image/png",
                name: "photo.png",
                sizeBytes: png.length,
              }),
            ],
          },
        ],
      }),
    });
    const attachment =
      vi.mocked(sendOutboundRequest).mock.calls[0]?.[0]?.request.payloads[0]?.attachments?.[0];
    expect(attachment).not.toHaveProperty("url");
  });

  it("delivers structured payloads without dropping channelData", async () => {
    const sendOutboundRequest = vi.fn(async ({ request }) =>
      createBrokerReceipt({
        requestId: request.requestId,
        providerId: "acme",
        platform: request.platform,
        status: "sent",
        messageIds: ["native-payload-1"],
      }),
    );
    setChannelBrokerRuntime({
      sendOutboundRequest,
      createRequestId: () => "broker-payload-1",
    });

    const result = await channelBrokerPlugin.message?.send?.payload?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["discord"],
                capabilities: {
                  discord: {
                    delivery: { text: true, payload: true, progressUpdates: true, thread: true },
                  },
                },
              },
            },
          },
        },
      },
      accountId: "acme",
      to: "discord:channel:222?threadId=333",
      text: "tool progress",
      payload: {
        text: "tool progress",
        channelData: {
          openclaw: {
            sourceReplyDeliveryMode: "message_tool_only",
            verboseLevel: "full",
          },
        },
      },
    } as never);

    expect(result?.messageId).toBe("native-payload-1");
    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        mode: "final",
        requirements: expect.objectContaining({ payload: true, text: true, thread: true }),
        payloads: [
          {
            text: "tool progress",
            channelData: {
              openclaw: {
                sourceReplyDeliveryMode: "message_tool_only",
                verboseLevel: "full",
              },
            },
          },
        ],
      }),
    });
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

  it("canonicalizes unencoded DM shorthands without making them opaque ids", () => {
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

    const platformResult = channelBrokerPlugin.outbound?.resolveTarget?.({
      cfg,
      accountId: "acme",
      to: "slack:user:U123",
    } as never);
    const brokerResult = channelBrokerPlugin.outbound?.resolveTarget?.({
      cfg,
      accountId: "acme",
      to: "broker:slack:user:U123",
    } as never);

    expect(platformResult).toEqual({
      ok: true,
      to: "slack:U123?conversationType=direct",
    });
    expect(brokerResult).toEqual({
      ok: true,
      to: "broker:slack:U123?conversationType=direct",
    });
  });

  it("applies account defaults only during outbound target resolution", () => {
    const result = channelBrokerPlugin.outbound?.resolveTarget?.({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                platforms: ["telegram"],
                defaultPlatform: "telegram",
                defaultConversationType: "direct",
              },
            },
          },
        },
      },
      accountId: "acme",
      to: "broker:12345",
    } as never);

    expect(result).toEqual({
      ok: true,
      to: "broker:telegram:12345?conversationType=direct",
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

  it("propagates attached outbound send failures", async () => {
    setChannelBrokerRuntime({
      sendOutboundRequest: vi.fn(async () => {
        throw new Error("broker send failed");
      }),
      createRequestId: () => "broker-send-failure-1",
    });

    await expect(
      channelBrokerPlugin.outbound?.sendText?.({
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
        to: "broker:slack:C123",
        text: "will fail",
        accountId: "acme",
      } as never),
    ).rejects.toThrow("broker send failed");
  });

  it("preserves media sends through the lazy outbound adapter", async () => {
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

    const result = await channelBrokerPlugin.outbound?.sendMedia?.({
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
      to: "broker:slack:C123",
      text: "caption",
      mediaUrl: "https://cdn.example.test/photo.png",
      accountId: "acme",
    } as never);

    expect(result).toEqual({ channel: "channel-broker", messageId: "native-media-1" });
    expect(sendOutboundRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          requestId: "broker-media-1",
          platform: "slack",
          payloads: [
            expect.objectContaining({
              text: "caption",
              attachments: [
                expect.objectContaining({
                  url: "https://cdn.example.test/photo.png",
                  mediaType: "media",
                }),
              ],
            }),
          ],
          requirements: expect.objectContaining({ text: true, media: true }),
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
