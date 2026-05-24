import {
  brokerPlatformSupports,
  buildBrokerInboundDedupeKey,
  createBrokerInboundEvent,
  createBrokerOutboundRequest,
  createBrokerReceipt,
  resolveBrokerPlatformCapabilities,
} from "openclaw/plugin-sdk/channel-broker";
import {
  createDurableInboundReceiveJournal,
  resolveChannelMessageSourceReplyDeliveryMode,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendChannelBrokerText } from "./outbound.js";
import { resetChannelBrokerRuntimeForTest, setChannelBrokerRuntime } from "./runtime.js";

type ConformancePayload = {
  providerId: string;
  platform: string;
  nativeMessageId: string;
};

type ConformanceMetadata = {
  phase: "received" | "completed";
};

type MemoryStoreEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
};

function createMemoryStore<T>() {
  const values = new Map<string, MemoryStoreEntry<T>>();
  return {
    async register(key, value) {
      values.set(key, { key, value, createdAt: 1 });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { key, value, createdAt: 1 });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return Array.from(values.values());
    },
    async clear() {
      values.clear();
    },
  };
}

describe("channel-broker conformance baseline", () => {
  beforeEach(() => {
    resetChannelBrokerRuntimeForTest();
  });

  it("normalizes inbound events before duplicate/redelivery durable receive handling", async () => {
    const inbound = createBrokerInboundEvent({
      eventId: " update-1 ",
      providerId: " acme ",
      platform: "Telegram",
      accountId: " bot-main ",
      conversation: {
        id: " -100123 ",
        type: "thread",
        parentId: "-100123",
        threadId: " 77 ",
      },
      sender: { id: " user-1 ", handle: " lume " },
      message: {
        id: " 101 ",
        text: " /verbose status ",
        nativeIds: { message_id: " 101 " },
      },
    });
    const dedupeKey = buildBrokerInboundDedupeKey(inbound);
    const journal = createDurableInboundReceiveJournal<
      ConformancePayload,
      ConformanceMetadata,
      ConformanceMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 100,
    });
    const payload = {
      providerId: inbound.providerId,
      platform: inbound.platform,
      nativeMessageId: inbound.message.id,
    };

    await expect(
      journal.accept(dedupeKey, payload, { metadata: { phase: "received" } }),
    ).resolves.toMatchObject({
      kind: "accepted",
      duplicate: false,
      record: {
        id: "acme:bot-main:telegram:update-1",
        payload,
        metadata: { phase: "received" },
      },
    });
    await expect(
      journal.accept(dedupeKey, { ...payload, nativeMessageId: "changed" }),
    ).resolves.toMatchObject({
      kind: "pending",
      duplicate: true,
      record: { payload },
    });

    await expect(journal.release(dedupeKey, { lastError: "provider redelivery" })).resolves.toBe(
      true,
    );
    await expect(journal.pending()).resolves.toMatchObject([
      {
        id: "acme:bot-main:telegram:update-1",
        attempts: 1,
        lastError: "provider redelivery",
      },
    ]);

    await journal.complete(dedupeKey, { metadata: { phase: "completed" }, completedAt: 200 });
    await expect(journal.accept(dedupeKey, payload)).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
      record: { completedAt: 200, metadata: { phase: "completed" } },
    });
  });

  it("proves durable final send, receipt commit material, and multi-id provider receipts", async () => {
    const sendOutboundRequest = vi.fn(async () =>
      createBrokerReceipt({
        requestId: "broker-final-1",
        providerId: "acme",
        platform: "Slack",
        status: "sent",
        messageIds: ["1716500000.000100", "1716500000.000101"],
        timestamp: 123,
        editToken: "1716500000.000101",
        deleteToken: "delete-token",
      }),
    );
    setChannelBrokerRuntime({ createRequestId: () => "broker-final-1", sendOutboundRequest });

    const result = await sendChannelBrokerText({
      cfg: {
        channels: {
          "channel-broker": {
            accounts: {
              acme: {
                enabled: true,
                baseUrl: "https://broker.example.test",
                defaultConversationType: "channel",
              },
            },
          },
        },
      },
      accountId: "acme",
      to: "slack:C123?threadId=1716500000.000001",
      text: "final answer",
      replyToId: "1716500000.000000",
    });

    expect(sendOutboundRequest).toHaveBeenCalledWith({
      account: expect.objectContaining({ providerId: "acme" }),
      request: expect.objectContaining({
        requestId: "broker-final-1",
        providerId: "acme",
        platform: "slack",
        conversation: {
          id: "C123",
          type: "channel",
          threadId: "1716500000.000001",
        },
        mode: "final",
        payloads: [{ text: "final answer" }],
        relation: { replyToId: "1716500000.000000" },
        requirements: { text: true, replyTo: true, thread: true },
      }),
    });
    expect(result).toMatchObject({
      messageId: "1716500000.000100",
      receipt: {
        primaryPlatformMessageId: "1716500000.000100",
        platformMessageIds: ["1716500000.000100", "1716500000.000101"],
        threadId: "1716500000.000001",
        replyToId: "1716500000.000000",
        editToken: "1716500000.000101",
        deleteToken: "delete-token",
        sentAt: 123,
      },
    });
  });

  it("turns retryable, failed, and unsupported provider receipts into durable-send failures", async () => {
    setChannelBrokerRuntime({
      createRequestId: () => "broker-retry-1",
      sendOutboundRequest: vi.fn(async () =>
        createBrokerReceipt({
          requestId: "broker-retry-1",
          providerId: "acme",
          platform: "Discord",
          status: "retryable",
          messageIds: [],
          retryAfterMs: 5000,
          error: { code: "rate_limited", message: "rate limited", retryable: true },
        }),
      ),
    });

    await expect(
      sendChannelBrokerText({
        cfg: {
          channels: {
            "channel-broker": {
              accounts: { acme: { enabled: true, baseUrl: "https://broker.example.test" } },
            },
          },
        },
        accountId: "acme",
        to: "discord:channel%3A123",
        text: "retry me",
      }),
    ).rejects.toMatchObject({
      name: "ChannelBrokerProviderReceiptError",
      receipt: { status: "retryable", retryAfterMs: 5000 },
    });
  });

  it("requires preview and progress behavior to flow through provider capabilities", () => {
    const capabilities = {
      providerId: "acme",
      platforms: [
        {
          platform: "Discord",
          delivery: { text: true, previewFinalization: true, progressUpdates: true },
          live: { draftPreview: true, progressUpdates: true, previewFinalization: true },
          receive: { webhook: true, ackAfterDurableSend: true },
        },
      ],
    };
    const preview = createBrokerOutboundRequest({
      requestId: "preview-1",
      providerId: "acme",
      platform: "discord",
      conversation: { id: "channel:123", type: "channel", threadId: "thread-1" },
      mode: "preview_update",
      payloads: [{ text: "Working..." }],
      requirements: { text: true, progressUpdates: true },
    });
    const finalize = createBrokerOutboundRequest({
      requestId: "preview-2",
      providerId: "acme",
      platform: "discord",
      conversation: { id: "channel:123", type: "channel", threadId: "thread-1" },
      mode: "finalize_preview",
      payloads: [{ text: "Done" }],
      requirements: { text: true, previewFinalization: true },
    });

    expect(preview.mode).toBe("preview_update");
    expect(finalize.mode).toBe("finalize_preview");
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "discord",
        requirements: {
          delivery: { text: true, progressUpdates: true, previewFinalization: true },
          live: { draftPreview: true, progressUpdates: true, previewFinalization: true },
          receive: { webhook: true, ackAfterDurableSend: true },
        },
      }),
    ).toBe(true);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "discord",
        requirements: { delivery: { nativeStreaming: true } },
      }),
    ).toBe(false);
  });

  it("keeps official/app channel differences in broker capability declarations", () => {
    const capabilities = {
      providerId: "acme-official",
      delivery: { text: true },
      receive: { webhook: true, ackAfterDurableSend: true },
      platforms: [
        {
          platform: "microsoft-teams",
          delivery: { media: true, replyTo: true, thread: true },
          native: { appApi: true, workspaceHosted: true },
        },
        {
          platform: "google-chat",
          delivery: { media: true, replyTo: true, thread: true },
          native: { appApi: true, workspaceHosted: true },
        },
        {
          platform: "matrix",
          delivery: { media: true, replyTo: true, thread: true },
          receive: { polling: true },
          native: { bridgeApi: true, selfHostedOptional: true },
        },
        {
          platform: "line",
          delivery: { media: true, replyTo: true },
          native: { appApi: true, replyTokenWindow: true },
        },
        {
          platform: "feishu",
          delivery: { media: true, replyTo: true, thread: true },
          native: { appApi: true, workspaceHosted: true },
        },
        {
          platform: "qqbot",
          delivery: { media: true },
          native: { botApi: true, regionalApi: true },
        },
        {
          platform: "zalo",
          delivery: { media: true },
          native: { botApi: true, regionalApi: true },
        },
        {
          platform: "mattermost",
          delivery: { media: true, replyTo: true, thread: true },
          native: { appApi: true, selfHostedOptional: true },
        },
        {
          platform: "nextcloud-talk",
          delivery: { media: true, replyTo: true, thread: true },
          native: { appApi: true, selfHostedOptional: true },
        },
        {
          platform: "twitch",
          delivery: { media: false, thread: false },
          native: { chatApi: true, channelOnly: true },
        },
        {
          platform: "irc",
          delivery: { media: false, replyTo: false, thread: false },
          receive: { polling: true },
          native: { bridgeApi: true },
        },
        {
          platform: "nostr",
          delivery: { replyTo: true },
          native: { relayBased: true },
        },
        {
          platform: "tlon",
          delivery: { replyTo: true, thread: true },
          native: { appApi: true, selfHostedOptional: true },
        },
        {
          platform: "synology-chat",
          delivery: { replyTo: true },
          native: { appApi: true, selfHostedOptional: true },
        },
      ],
    };

    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "microsoft-teams",
        requirements: {
          delivery: { text: true, thread: true, replyTo: true },
          receive: { webhook: true, ackAfterDurableSend: true },
          native: { appApi: true },
        },
      }),
    ).toBe(true);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "matrix",
        requirements: {
          delivery: { text: true, media: true },
          receive: { webhook: true, polling: true },
          native: { bridgeApi: true },
        },
      }),
    ).toBe(true);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "twitch",
        requirements: { delivery: { thread: true } },
      }),
    ).toBe(false);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "irc",
        requirements: { delivery: { media: true } },
      }),
    ).toBe(false);
  });

  it("models constrained providers with explicit broker constraints and badges", () => {
    const capabilities = {
      providerId: "acme-constrained",
      delivery: { text: true },
      receive: { webhook: true, ackAfterDurableSend: true },
      platforms: [
        {
          platform: "whatsapp",
          delivery: { media: true, replyTo: true },
          constraints: {
            businessApi: true,
            cloudApi: true,
            providerHosted: true,
            deviceBound: false,
          },
          badges: ["business-api", "provider-hosted"],
          native: { cloudApi: true },
        },
        {
          platform: "signal",
          constraints: {
            selfHosted: true,
            deviceBound: true,
            phoneNumberRequired: true,
            signalCli: true,
          },
          badges: ["self-hosted", "device-bound"],
          native: { signalCli: true },
        },
        {
          platform: "imessage",
          delivery: { media: true, replyTo: true },
          constraints: {
            deviceBound: true,
            macHostRequired: true,
            messagesSignedIn: true,
            privateApiOptional: true,
          },
          badges: ["mac-host", "device-bound"],
          native: { imsg: true },
        },
        {
          platform: "imessage-bluebubbles",
          delivery: { media: true },
          constraints: {
            externalBridge: true,
            deviceBound: true,
          },
          badges: ["external-bridge"],
          native: { blueBubbles: true },
        },
      ],
    };

    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "whatsapp",
        requirements: {
          delivery: { text: true, media: true },
          constraints: { businessApi: true, providerHosted: true },
        },
      }),
    ).toBe(true);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "whatsapp",
        requirements: { constraints: { deviceBound: true } },
      }),
    ).toBe(false);
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "signal",
        requirements: {
          delivery: { text: true },
          constraints: { selfHosted: true, deviceBound: true, phoneNumberRequired: true },
          native: { signalCli: true },
        },
      }),
    ).toBe(true);

    const iMessage = resolveBrokerPlatformCapabilities({ capabilities, platform: "imessage" });
    expect(iMessage?.badges).toEqual(["mac-host", "device-bound"]);
    expect(iMessage?.constraints).toEqual({
      deviceBound: true,
      macHostRequired: true,
      messagesSignedIn: true,
      privateApiOptional: true,
    });
    expect(
      brokerPlatformSupports({
        capabilities,
        platform: "imessage-bluebubbles",
        requirements: { constraints: { externalBridge: true, deviceBound: true } },
      }),
    ).toBe(true);
  });

  it("keeps /verbose and tool-message policy in broker channelData instead of platform branches", () => {
    const sourceReplyDeliveryMode = resolveChannelMessageSourceReplyDeliveryMode({
      cfg: { messages: { visibleReplies: "message_tool" } } as never,
      ctx: { ChatType: "channel" },
      requested: "message_tool_only",
      messageToolAvailable: true,
    });
    const request = createBrokerOutboundRequest({
      requestId: "tool-1",
      providerId: "acme",
      platform: "Slack",
      conversation: { id: "C123", type: "channel", threadId: "1716500000.000001" },
      mode: "preview_update",
      payloads: [
        {
          text: "Tool output",
          channelData: {
            openclaw: {
              sourceReplyDeliveryMode,
              verboseLevel: "full",
              toolCallId: "tool-call-1",
            },
          },
        },
      ],
      requirements: { text: true, progressUpdates: true },
    });

    expect(sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(request.payloads[0]?.channelData).toEqual({
      openclaw: {
        sourceReplyDeliveryMode: "message_tool_only",
        verboseLevel: "full",
        toolCallId: "tool-call-1",
      },
    });
  });
});
