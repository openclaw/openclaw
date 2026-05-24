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

    const result = await channelBrokerPlugin.message?.send.text?.({
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

    const result = await channelBrokerPlugin.message?.send.text?.({
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
