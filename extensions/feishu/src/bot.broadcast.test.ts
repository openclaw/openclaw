import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/extensions/plugin-runtime-mock.js";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const { mockCreateFeishuReplyDispatcher, mockCreateFeishuClient, mockResolveAgentRoute } =
  vi.hoisted(() => ({
    mockCreateFeishuReplyDispatcher: vi.fn(() => ({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    })),
    mockCreateFeishuClient: vi.fn(),
    mockResolveAgentRoute: vi.fn(),
  }));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

describe("broadcast dispatch", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: unknown) => ctx);
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockWithReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      run,
      onSettled,
    }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
      try {
        return await run();
      } finally {
        dispatcher.markComplete();
        try {
          await dispatcher.waitForIdle();
        } finally {
          await onSettled?.();
        }
      }
    },
  );
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/inbound-clip.mp4",
    contentType: "video/mp4",
  });

  function createBroadcastConfig(): ClawdbotConfig {
    return {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    };
  }

  function createBroadcastEvent(options: {
    messageId: string;
    text: string;
    botMentioned?: boolean;
  }): FeishuMessageEvent {
    return {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: options.messageId,
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: options.text }),
        ...(options.botMentioned
          ? {
              mentions: [
                {
                  key: "@_user_1",
                  id: { open_id: "bot-open-id" },
                  name: "Bot",
                  tenant_key: "",
                },
              ],
            }
          : {}),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    setFeishuRuntime(
      createPluginRuntimeMock({
        system: {
          enqueueSystemEvent: vi.fn(),
        },
        channel: {
          routing: {
            resolveAgentRoute: (params) => mockResolveAgentRoute(params),
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" })),
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext: mockFinalizeInboundContext,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher: mockWithReplyDispatcher,
          },
          commands: {
            shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
            resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          },
          media: {
            saveMediaBuffer: mockSaveMediaBuffer,
          },
          pairing: {
            readAllowFromStore: vi.fn().mockResolvedValue([]),
            upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
            buildPairingReply: vi.fn(() => "Pairing response"),
          },
        },
        media: {
          detectMime: vi.fn(async () => "application/octet-stream"),
        },
      }),
    );
  });

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-mentioned",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    const sessionKeys = mockFinalizeInboundContext.mock.calls.map(
      (call: unknown[]) => (call[0] as { SessionKey: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-not-mentioned",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "ou_known_bot",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
  });

  it("skips broadcast dispatch when bot identity is unknown (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-unknown-bot-id",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
  });

  it("preserves single-agent dispatch when no broadcast config", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-no-broadcast",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: "agent:main:feishu:group:oc-broadcast-group",
      }),
    );
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-multi-account-dedup",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    mockDispatchReplyFromConfig.mockClear();
    mockFinalizeInboundContext.mockClear();

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-B",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("skips unknown agents not in agents.list", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-unknown-agent",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const sessionKey = (mockFinalizeInboundContext.mock.calls[0]?.[0] as { SessionKey: string })
      .SessionKey;
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
