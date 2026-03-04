import type { ClawdbotConfig, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../test-utils/plugin-runtime-mock.js";
import type { FeishuMessageEvent } from "./bot.js";
import {
  buildBroadcastSessionKey,
  buildFeishuAgentBody,
  handleFeishuMessage,
  resolveBroadcastAgents,
  toMessageResourceType,
} from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockDownloadMessageResourceFeishu,
  mockCreateFeishuClient,
  mockResolveAgentRoute,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: vi.fn(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockDownloadMessageResourceFeishu: vi.fn().mockResolvedValue({
    buffer: Buffer.from("video"),
    contentType: "video/mp4",
    fileName: "clip.mp4",
  }),
  mockCreateFeishuClient: vi.fn(),
  mockResolveAgentRoute: vi.fn(() => ({
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  })),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: mockGetMessageFeishu,
}));

vi.mock("./media.js", () => ({
  downloadMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  } as RuntimeEnv;
}

async function dispatchMessage(params: { cfg: ClawdbotConfig; event: FeishuMessageEvent }) {
  await handleFeishuMessage({
    cfg: params.cfg,
    event: params.event,
    runtime: createRuntimeEnv(),
  });
}

describe("buildFeishuAgentBody", () => {
  it("builds message id, speaker, quoted content, mentions, and permission notice in order", () => {
    const body = buildFeishuAgentBody({
      ctx: {
        content: "hello world",
        senderName: "Sender Name",
        senderOpenId: "ou-sender",
        messageId: "msg-42",
        mentionTargets: [{ openId: "ou-target", name: "Target User", key: "@_user_1" }],
      },
      quotedContent: "previous message",
      permissionErrorForAgent: {
        code: 99991672,
        message: "permission denied",
        grantUrl: "https://open.feishu.cn/app/cli_test",
      },
    });

    expect(body).toBe(
      '[message_id: msg-42]\nSender Name: [Replying to: "previous message"]\n\nhello world\n\n[System: Your reply will automatically @mention: Target User. Do not write @xxx yourself.]\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: https://open.feishu.cn/app/cli_test]',
    );
  });
});

describe("handleFeishuMessage command authorization", () => {
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
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");
  const mockEnqueueSystemEvent = vi.fn();
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    id: "inbound-clip.mp4",
    path: "/tmp/inbound-clip.mp4",
    size: Buffer.byteLength("video"),
    contentType: "video/mp4",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldComputeCommandAuthorized.mockReset().mockReturnValue(true);
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:dm:ou-attacker",
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
    mockEnqueueSystemEvent.mockReset();
    setFeishuRuntime(
      createPluginRuntimeMock({
        system: {
          enqueueSystemEvent: mockEnqueueSystemEvent,
        },
        channel: {
          routing: {
            resolveAgentRoute:
              mockResolveAgentRoute as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
          },
          reply: {
            resolveEnvelopeFormatOptions: vi.fn(
              () => ({}),
            ) as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext:
              mockFinalizeInboundContext as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher:
              mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
          },
          commands: {
            shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
            resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
          },
          media: {
            saveMediaBuffer:
              mockSaveMediaBuffer as unknown as PluginRuntime["channel"]["media"]["saveMediaBuffer"],
          },
          pairing: {
            readAllowFromStore: mockReadAllowFromStore,
            upsertPairingRequest: mockUpsertPairingRequest,
            buildPairingReply: mockBuildPairingReply,
          },
        },
        media: {
          detectMime: vi.fn(async () => "application/octet-stream"),
        },
      }),
    );
  });

  it("does not enqueue inbound preview text as system events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-no-system-preview",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("uses authorizer resolution instead of hardcoded CommandAuthorized=true", async () => {
    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["ou-admin"],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-auth-bypass-regression",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        CommandAuthorized: false,
        SenderId: "ou-attacker",
        Surface: "feishu",
      }),
    );
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-read-store-non-command",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadAllowFromStore).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
    });
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("skips sender-name lookup when resolveSenderNames is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["*"],
          resolveSenderNames: false,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-skip-sender-lookup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuClient).not.toHaveBeenCalled();
  });

  it("propagates parent/root message ids into inbound context for reply reconstruction", async () => {
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_parent_001",
      chatId: "oc-group",
      content: "quoted content",
      contentType: "text",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-replier",
        },
      },
      message: {
        message_id: "om_reply_001",
        root_id: "om_root_001",
        parent_id: "om_parent_001",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "reply text" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "om_parent_001",
        RootMessageId: "om_root_001",
        ReplyToBody: "quoted content",
      }),
    );
  });

  it("replies pairing challenge to DM chat_id instead of user:sender id", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          user_id: "u_mobile_only",
        },
      },
      message: {
        message_id: "msg-pairing-chat-reply",
        chat_id: "oc_dm_chat_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({ cfg, event });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm_chat_1",
      }),
    );
  });
  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-unapproved",
        },
      },
      message: {
        message_id: "msg-pairing-flow",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockBuildPairingReply).toHaveBeenCalledWith({
      channel: "feishu",
      idLine: "Your Feishu user id: ou-unapproved",
      code: "ABCDEFGH",
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
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
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-command-auth",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: false, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: false,
        SenderId: "ou-attacker",
      }),
    );
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          allowFrom: ["ou-admin"],
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
          open_id: "ou-admin",
        },
      },
      message: {
        message_id: "msg-group-command-fallback",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: true }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: true,
        SenderId: "ou-admin",
      }),
    );
  });

  it("allows group sender when global groupSenderAllowFrom includes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
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
          open_id: "ou-allowed",
        },
      },
      message: {
        message_id: "msg-global-group-sender-allow",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        SenderId: "ou-allowed",
      }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("blocks group sender when global groupSenderAllowFrom excludes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
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
          open_id: "ou-blocked",
        },
      },
      message: {
        message_id: "msg-global-group-sender-block",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("prefers per-group allowFrom over global groupSenderAllowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-global"],
          groups: {
            "oc-group": {
              allowFrom: ["ou-group-only"],
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-global",
        },
      },
      message: {
        message_id: "msg-per-group-precedence",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops message when groupConfig.enabled is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-disabled-group": {
              enabled: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-disabled-group",
        chat_id: "oc-disabled-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("uses video file_key (not thumbnail image_key) for inbound video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-video-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "video",
        content: JSON.stringify({
          file_key: "file_video_payload",
          image_key: "img_thumb_payload",
          file_name: "clip.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-video-inbound",
        fileKey: "file_video_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("uses media message_type file_key (not thumbnail image_key) for inbound mobile video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-media-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_media_payload",
          image_key: "img_media_thumb",
          file_name: "mobile.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-media-inbound",
        fileKey: "file_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("downloads embedded media tags from post messages as files", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-post-media",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "Rich text",
          content: [
            [
              {
                tag: "media",
                file_key: "file_post_media_payload",
                file_name: "embedded.mov",
              },
            ],
          ],
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-post-media",
        fileKey: "file_post_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
    );
  });

  it("includes message_id in BodyForAgent on its own line", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-msgid",
        },
      },
      message: {
        message_id: "msg-message-id-line",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "[message_id: msg-message-id-line]\nou-msgid: hello",
      }),
    );
  });

  it("expands merge_forward content from API sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const mockGetMerged = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: "container",
            msg_type: "merge_forward",
            body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
          },
          {
            message_id: "sub-2",
            upper_message_id: "container",
            msg_type: "file",
            body: { content: JSON.stringify({ file_name: "report.pdf" }) },
            create_time: "2000",
          },
          {
            message_id: "sub-1",
            upper_message_id: "container",
            msg_type: "text",
            body: { content: JSON.stringify({ text: "alpha" }) },
            create_time: "1000",
          },
        ],
      },
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: mockGetMerged,
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge",
        },
      },
      message: {
        message_id: "msg-merge-forward",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockGetMerged).toHaveBeenCalledWith({
      path: { message_id: "msg-merge-forward" },
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "[Merged and Forwarded Messages]\n- alpha\n- [File: report.pdf]",
        ),
      }),
    );
  });

  it("falls back when merge_forward API returns no sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge-empty",
        },
      },
      message: {
        message_id: "msg-merge-empty",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("[Merged and Forwarded Message - could not fetch]"),
      }),
    );
  });

  it("dispatches once and appends permission notice to the main agent body", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
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

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "Permission grant URL: https://open.feishu.cn/app/cli_test",
        ),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm: hello group"),
      }),
    );
  });

  it("ignores stale non-existent contact scope permission errors", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied: contact:contact.base:readonly https://open.feishu.cn/app/cli_scope_bug",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_scope_bug",
          appSecret: "sec_scope_bug",
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
          open_id: "ou-perm-scope",
        },
      },
      message: {
        message_id: "msg-perm-scope-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.not.stringContaining("Permission grant URL"),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm-scope: hello group"),
      }),
    );
  });

  it("routes group sessions by sender when groupSessionScope=group_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-scope-user" } },
      message: {
        message_id: "msg-scope-group-sender",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "group sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:sender:ou-scope-user" },
        parentPeer: null,
      }),
    );
  });

  it("routes topic sessions and parentPeer when groupSessionScope=group_topic_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-sender",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("keeps root_id as topic key when root_id and thread_id both exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses thread_id as topic key when root_id is missing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-only",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:omt_topic_1:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to group_topic routing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy" } },
      message: {
        message_id: "msg-legacy-topic-mode",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to root_id when both root_id and thread_id exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy-thread-id" } },
      message: {
        message_id: "msg-legacy-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        thread_id: "omt_topic_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses message_id as topic root when group_topic + replyInThread and no root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-new-topic-root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-new-topic-root" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("keeps topic session key stable after first turn creates a thread", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const firstTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-first",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };
    const secondTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-second",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "msg-topic-first",
        thread_id: "omt_topic_created",
        message_type: "text",
        content: JSON.stringify({ text: "follow up in same topic" }),
      },
    };

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
  });

  it("replies to the topic root when handling a message inside an existing topic", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_child_message",
        root_id: "om_root_topic",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "reply inside topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_root_topic",
        rootId: "om_root_topic",
      }),
    );
  });

  it("forces thread replies when inbound message contains thread_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group",
              replyInThread: "disabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-thread-reply" } },
      message: {
        message_id: "msg-thread-reply",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_thread_reply",
        message_type: "text",
        content: JSON.stringify({ text: "thread content" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyInThread: true,
        threadReply: true,
      }),
    );
  });

  it("does not dispatch twice for the same image message_id (concurrent dedupe)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-image-dedup",
        },
      },
      message: {
        message_id: "msg-image-dedup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({
          image_key: "img_dedup_payload",
        }),
      },
    };

    await Promise.all([dispatchMessage({ cfg, event }), dispatchMessage({ cfg, event })]);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });
});

describe("toMessageResourceType", () => {
  it("maps image to image", () => {
    expect(toMessageResourceType("image")).toBe("image");
  });

  it("maps audio to file", () => {
    expect(toMessageResourceType("audio")).toBe("file");
  });

  it("maps video/file/sticker to file", () => {
    expect(toMessageResourceType("video")).toBe("file");
    expect(toMessageResourceType("file")).toBe("file");
    expect(toMessageResourceType("sticker")).toBe("file");
  });
});

describe("resolveBroadcastAgents", () => {
  it("returns agent list when broadcast config has the peerId", () => {
    const cfg = { broadcast: { oc_group123: ["susan", "main"] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toEqual(["susan", "main"]);
  });

  it("returns null when no broadcast config", () => {
    const cfg = {} as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });

  it("returns null when peerId not in broadcast", () => {
    const cfg = { broadcast: { oc_other: ["susan"] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });

  it("returns null when agent list is empty", () => {
    const cfg = { broadcast: { oc_group123: [] } } as unknown as ClawdbotConfig;
    expect(resolveBroadcastAgents(cfg, "oc_group123")).toBeNull();
  });
});

describe("buildBroadcastSessionKey", () => {
  it("replaces agent ID prefix in session key", () => {
    expect(buildBroadcastSessionKey("agent:main:feishu:group:oc_group123", "main", "susan")).toBe(
      "agent:susan:feishu:group:oc_group123",
    );
  });

  it("handles compound peer IDs", () => {
    expect(
      buildBroadcastSessionKey(
        "agent:main:feishu:group:oc_group123:sender:ou_user1",
        "main",
        "susan",
      ),
    ).toBe("agent:susan:feishu:group:oc_group123:sender:ou_user1");
  });

  it("returns base key unchanged when prefix does not match", () => {
    expect(buildBroadcastSessionKey("custom:key:format", "main", "susan")).toBe(
      "custom:key:format",
    );
  });
});

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
    setFeishuRuntime({
      system: {
        enqueueSystemEvent: vi.fn(),
      },
      channel: {
        routing: {
          resolveAgentRoute: mockResolveAgentRoute,
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
    } as unknown as PluginRuntime);
  });

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg: ClawdbotConfig = {
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
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-mentioned",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello @bot" }),
        mentions: [
          { key: "@_user_1", id: { open_id: "bot-open-id" }, name: "Bot", tenant_key: "" },
        ],
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    // Both agents should get dispatched
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    // Verify session keys for both agents
    const sessionKeys = mockFinalizeInboundContext.mock.calls.map(
      (call: unknown[]) => (call[0] as { SessionKey: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");

    // Active agent (mentioned) gets the real Feishu reply dispatcher
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg: ClawdbotConfig = {
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
    } as unknown as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-not-mentioned",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello everyone" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    // No dispatch: requireMention=true and bot not mentioned → returns early.
    // The mentioned bot's handler (on another account or same account with
    // matching botOpenId) will handle broadcast dispatch for all agents.
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
    } as ClawdbotConfig;

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

    // Single dispatch (no broadcast)
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
    } as unknown as ClawdbotConfig;

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

    // First account handles broadcast normally
    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    mockDispatchReplyFromConfig.mockClear();
    mockFinalizeInboundContext.mockClear();

    // Second account: same message ID, different account.
    // Per-account dedup passes (different namespace), but cross-account
    // broadcast dedup blocks dispatch.
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
    } as unknown as ClawdbotConfig;

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

    // Only susan should get dispatched (unknown-agent skipped)
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const sessionKey = (mockFinalizeInboundContext.mock.calls[0]?.[0] as { SessionKey: string })
      .SessionKey;
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
