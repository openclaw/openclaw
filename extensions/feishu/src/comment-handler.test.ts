import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import type { ClawdbotConfig } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { setFeishuRuntime } from "./runtime.js";

const resolveDriveCommentEventTurnMock = vi.hoisted(() => vi.fn());
const createFeishuCommentReplyDispatcherMock = vi.hoisted(() => vi.fn());
const maybeCreateDynamicAgentMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn(() => ({ request: vi.fn() })));
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.comment.js", () => ({
  resolveDriveCommentEventTurn: resolveDriveCommentEventTurnMock,
}));

vi.mock("./comment-dispatcher.js", () => ({
  createFeishuCommentReplyDispatcher: createFeishuCommentReplyDispatcherMock,
}));

vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: maybeCreateDynamicAgentMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

function buildConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
      },
    },
    ...overrides,
  } as ClawdbotConfig;
}

function buildResolvedRoute(matchedBy: "binding.channel" | "default" = "binding.channel") {
  return {
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:direct:ou_sender",
    mainSessionKey: "agent:main:feishu",
    lastRoutePolicy: "session" as const,
    matchedBy,
  };
}

describe("handleFeishuCommentEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeCreateDynamicAgentMock.mockResolvedValue({ created: false });
    resolveDriveCommentEventTurnMock.mockResolvedValue({
      eventId: "evt_1",
      messageId: "drive-comment:evt_1",
      commentId: "comment_1",
      replyId: "reply_1",
      noticeType: "add_comment",
      fileToken: "doc_token_1",
      fileType: "docx",
      isWholeComment: false,
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: true,
      documentTitle: "Project review",
      prompt: "prompt body",
      preview: "prompt body",
      rootCommentText: "root comment",
      targetReplyText: "latest reply",
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "r1",
    });

    const runtime = createPluginRuntimeMock({
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(() => buildResolvedRoute()),
        },
        reply: {
          dispatchReplyFromConfig: vi.fn(async () => ({
            queuedFinal: true,
            counts: { tool: 0, block: 0, final: 1 },
          })),
          withReplyDispatcher: vi.fn(async ({ run, onSettled }) => {
            try {
              return await run();
            } finally {
              await onSettled?.();
            }
          }),
        },
      },
    });
    setFeishuRuntime(runtime);

    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcher: {
        markComplete: vi.fn(),
        waitForIdle: vi.fn(async () => {}),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });
  });

  it("records a comment-thread inbound context with a routable Feishu origin", async () => {
    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const runtime = (await import("./runtime.js")).getFeishuRuntime();
    const finalizeInboundContext = runtime.channel.reply.finalizeInboundContext as ReturnType<
      typeof vi.fn
    >;
    const recordInboundSession = runtime.channel.session.recordInboundSession as ReturnType<
      typeof vi.fn
    >;
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;

    expect(finalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        From: "feishu:ou_sender",
        To: "comment:docx:doc_token_1:comment_1",
        Surface: "feishu-comment",
        OriginatingChannel: "feishu",
        OriginatingTo: "comment:docx:doc_token_1:comment_1",
        MessageSid: "drive-comment:evt_1",
      }),
    );
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("allows comment senders matched by user_id allowlist entries", async () => {
    const runtime = createPluginRuntimeMock({
      channel: {
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => buildResolvedRoute()),
        },
        reply: {
          dispatchReplyFromConfig: vi.fn(async () => ({
            queuedFinal: true,
            counts: { tool: 0, block: 0, final: 1 },
          })),
          withReplyDispatcher: vi.fn(async ({ run, onSettled }) => {
            try {
              return await run();
            } finally {
              await onSettled?.();
            }
          }),
        },
      },
    });
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: ["on_sender_user"],
          },
        },
      }),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge in the comment thread when dmPolicy=pairing", async () => {
    const runtime = createPluginRuntimeMock({
      channel: {
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(async () => ({ code: "TESTCODE", created: true })),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => buildResolvedRoute()),
        },
      },
    });
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file_token: "doc_token_1",
        file_type: "docx",
        comment_id: "comment_1",
        is_whole_comment: false,
      }),
    );
    const dispatchReplyFromConfig = runtime.channel.reply.dispatchReplyFromConfig as ReturnType<
      typeof vi.fn
    >;
    expect(dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("passes whole-comment metadata to the comment reply dispatcher", async () => {
    resolveDriveCommentEventTurnMock.mockResolvedValueOnce({
      eventId: "evt_whole",
      messageId: "drive-comment:evt_whole",
      commentId: "comment_whole",
      replyId: "reply_whole",
      noticeType: "add_reply",
      fileToken: "doc_token_1",
      fileType: "docx",
      isWholeComment: true,
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: false,
      documentTitle: "Project review",
      prompt: "prompt body",
      preview: "prompt body",
      rootCommentText: "root comment",
      targetReplyText: "reply text",
    });

    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_whole" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(createFeishuCommentReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commentId: "comment_whole",
        fileToken: "doc_token_1",
        fileType: "docx",
        isWholeComment: true,
      }),
    );
  });
});
