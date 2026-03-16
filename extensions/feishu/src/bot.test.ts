import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { FeishuMessageEvent } from "./bot.js";

const mocks = vi.hoisted(() => ({
  dispatchReplyFromConfig: vi.fn(async () => ({ queuedFinal: true, counts: { final: 1 } })),
  finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
  formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
  resolveEnvelopeFormatOptions: vi.fn(() => undefined),
  createFeishuClient: vi.fn(),
  createFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: {
      sendToolResult: vi.fn(),
      sendBlockReply: vi.fn(),
      sendFinalReply: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_GROUP_HISTORY_LIMIT: 8,
  buildPendingHistoryContextFromMap: vi.fn(({ currentMessage }: { currentMessage: string }) => currentMessage),
  recordPendingHistoryEntryIfEnabled: vi.fn(),
  clearHistoryEntriesIfEnabled: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn(() => ({
    accountId: "default",
    appId: "cli_test",
    appSecret: "sec_test",
    configured: true,
    config: {
      appId: "cli_test",
      appSecret: "sec_test",
      groups: {
        "oc-group": {
          requireMention: false,
        },
      },
    },
  })),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mocks.createFeishuClient,
}));

vi.mock("./media.js", () => ({
  downloadMessageResourceFeishu: vi.fn(),
}));

vi.mock("./mention.js", () => ({
  extractMentionTargets: vi.fn(() => []),
  extractMessageBody: vi.fn((body: string) => body),
  isMentionForwardRequest: vi.fn(() => false),
}));

vi.mock("./policy.js", () => ({
  resolveFeishuGroupConfig: vi.fn(() => undefined),
  resolveFeishuReplyPolicy: vi.fn(() => ({ requireMention: false })),
  resolveFeishuAllowlistMatch: vi.fn(() => ({ allowed: true })),
  isFeishuGroupAllowed: vi.fn(() => true),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mocks.createFeishuReplyDispatcher,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: vi.fn(() => ({
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          sessionKey: "agent:main:main",
          accountId: "default",
          agentId: "main",
        })),
      },
      media: {
        saveMediaBuffer: vi.fn(),
      },
      reply: {
        resolveEnvelopeFormatOptions: mocks.resolveEnvelopeFormatOptions,
        formatAgentEnvelope: mocks.formatAgentEnvelope,
        finalizeInboundContext: mocks.finalizeInboundContext,
        dispatchReplyFromConfig: mocks.dispatchReplyFromConfig,
      },
    },
  })),
}));

vi.mock("./send.js", () => ({
  getMessageFeishu: vi.fn(async () => undefined),
}));

const { handleFeishuMessage, buildFeishuAgentBody } = await import("./bot.js");

describe("buildFeishuAgentBody", () => {
  it("merges permission notice into the main agent body", () => {
    const body = buildFeishuAgentBody({
      speaker: "孙之远",
      content: "你好",
      permissionErrorForAgent: {
        code: 99991672,
        message: "permission denied",
        grantUrl: "https://open.feishu.cn/app/cli_test",
      },
    });

    expect(body).toContain("孙之远: 你好");
    expect(body).toContain("Permission grant URL: https://open.feishu.cn/app/cli_test");
  });
});

describe("handleFeishuMessage", () => {
  beforeEach(() => {
    mocks.dispatchReplyFromConfig.mockClear();
    mocks.finalizeInboundContext.mockClear();
    mocks.formatAgentEnvelope.mockClear();
    mocks.createFeishuClient.mockReset();
  });

  it("dispatches only once when sender-name lookup hits a permission error", async () => {
    mocks.createFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied https://open.feishu.cn/app/cli_test",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-perm",
        },
      },
      message: {
        message_id: "msg-perm-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await handleFeishuMessage({ cfg, event });

    expect(mocks.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        Body: expect.stringContaining("Permission grant URL: https://open.feishu.cn/app/cli_test"),
        MessageSid: "msg-perm-1",
      }),
    );
  });
});
