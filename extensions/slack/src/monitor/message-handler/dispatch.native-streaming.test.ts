import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../../../../src/auto-reply/types.js";
import type { PreparedSlackMessage } from "./types.js";

const dispatchInboundMessageMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const createSlackDraftStreamMock = vi.hoisted(() => vi.fn());
const resolveSlackStreamingConfigMock = vi.hoisted(() => vi.fn());
const startSlackStreamMock = vi.hoisted(() => vi.fn());
const appendSlackStreamMock = vi.hoisted(() => vi.fn());
const stopSlackStreamMock = vi.hoisted(() => vi.fn());
const deliverRepliesMock = vi.hoisted(() => vi.fn());
const createSlackReplyDeliveryPlanMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../../src/agents/identity.js", () => ({
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

vi.mock("../../../../../src/auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: (...args: unknown[]) => dispatchInboundMessageMock(...args),
}));

vi.mock("../../../../../src/auto-reply/reply/history.js", () => ({
  clearHistoryEntriesIfEnabled: vi.fn(),
}));

vi.mock("../../../../../src/auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: (...args: unknown[]) =>
    createReplyDispatcherWithTypingMock(...args),
}));

vi.mock("../../../../../src/channels/ack-reactions.js", () => ({
  removeAckReactionAfterReply: vi.fn(),
}));

vi.mock("../../../../../src/channels/logging.js", () => ({
  logAckFailure: vi.fn(),
  logTypingFailure: vi.fn(),
}));

vi.mock("../../../../../src/channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: vi.fn() })),
}));

vi.mock("../../../../../src/channels/typing.js", () => ({
  createTypingCallbacks: vi.fn(() => ({ onIdle: vi.fn() })),
}));

vi.mock("../../../../../src/config/sessions.js", () => ({
  resolveStorePath: vi.fn(),
  updateLastRoute: vi.fn(),
}));

vi.mock("../../../../../src/globals.js", () => ({
  danger: (value: string) => value,
  logVerbose: vi.fn(),
  shouldLogVerbose: vi.fn(() => false),
}));

vi.mock("../../../../../src/infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn(() => undefined),
}));

vi.mock("../../../../../src/security/dm-policy-shared.js", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: vi.fn(),
}));

vi.mock("../../actions.js", () => ({
  editSlackMessage: vi.fn(),
  reactSlackMessage: vi.fn(),
  removeSlackReaction: vi.fn(),
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: (...args: unknown[]) => createSlackDraftStreamMock(...args),
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (value: string) => value,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: vi.fn(),
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: vi.fn(),
  buildStatusFinalPreviewText: vi.fn(),
  resolveSlackStreamingConfig: (...args: unknown[]) => resolveSlackStreamingConfigMock(...args),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: (...args: unknown[]) => appendSlackStreamMock(...args),
  startSlackStream: (...args: unknown[]) => startSlackStreamMock(...args),
  stopSlackStream: (...args: unknown[]) => stopSlackStreamMock(...args),
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: vi.fn(() => ({ statusThreadTs: "1000.2", isThreadReply: false })),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: vi.fn(),
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: (...args: unknown[]) => createSlackReplyDeliveryPlanMock(...args),
  deliverReplies: (...args: unknown[]) => deliverRepliesMock(...args),
  readSlackReplyBlocks: (
    payload: ReplyPayload & { channelData?: { slack?: { blocks?: unknown[] } } },
  ) => payload.channelData?.slack?.blocks,
  resolveSlackThreadTs: vi.fn(({ messageTs }: { messageTs?: string }) => messageTs),
}));

import { dispatchPreparedSlackMessage } from "./dispatch.js";

describe("dispatchPreparedSlackMessage native Slack streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    createReplyDispatcherWithTypingMock.mockImplementation(
      (params: { deliver: (payload: ReplyPayload) => Promise<void> }) => ({
        dispatcher: { deliver: params.deliver },
        replyOptions: {},
        markDispatchIdle: vi.fn(),
      }),
    );

    createSlackDraftStreamMock.mockReturnValue({
      flush: vi.fn(async () => {}),
      stop: vi.fn(),
      clear: vi.fn(async () => {}),
      update: vi.fn(),
      forceNewMessage: vi.fn(),
      messageId: vi.fn(() => undefined),
      channelId: vi.fn(() => undefined),
    });

    resolveSlackStreamingConfigMock.mockReturnValue({
      mode: "partial",
      nativeStreaming: true,
      draftMode: "off",
    });

    createSlackReplyDeliveryPlanMock.mockReturnValue({
      nextThreadTs: vi.fn(() => "1000.2"),
      markSent: vi.fn(),
    });

    startSlackStreamMock.mockResolvedValue({
      streamer: {},
      channel: "C123",
      threadTs: "1000.2",
      stopped: false,
    });

    stopSlackStreamMock.mockImplementation(
      async ({ session }: { session: { stopped: boolean } }) => {
        session.stopped = true;
      },
    );
  });

  it("finalizes an active stream into blocks instead of posting a duplicate fallback reply", async () => {
    dispatchInboundMessageMock.mockImplementation(
      async (params: { dispatcher: { deliver: (payload: ReplyPayload) => Promise<void> } }) => {
        await params.dispatcher.deliver({ text: "partial preview" });
        await params.dispatcher.deliver({
          text: "Final block reply",
          channelData: {
            slack: {
              blocks: [{ type: "section", text: { type: "mrkdwn", text: "Final block reply" } }],
            },
          },
        } as ReplyPayload);
        return { queuedFinal: false, counts: { final: 1, block: 0 } };
      },
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(startSlackStreamMock).toHaveBeenCalledOnce();
    expect(stopSlackStreamMock).toHaveBeenCalledOnce();
    expect(stopSlackStreamMock.mock.calls[0]?.[0]).toMatchObject({
      text: "Final block reply",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Final block reply" } }],
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });
});

function createPreparedSlackMessage(): PreparedSlackMessage {
  return {
    ctx: {
      cfg: {},
      runtime: {},
      app: { client: { chat: { update: vi.fn() } } },
      setSlackThreadStatus: vi.fn(async () => {}),
      typingReaction: undefined,
      botToken: "xoxb-test",
      teamId: "T123",
      textLimit: 4000,
      channelHistories: new Map(),
      historyLimit: 20,
      removeAckAfterReply: false,
    },
    account: {
      accountId: "acct",
      config: {
        streaming: "partial",
        nativeStreaming: true,
        blockStreaming: true,
      },
    },
    message: {
      channel: "C123",
      ts: "1000.1",
      user: "U123",
    },
    route: {
      agentId: "main",
      accountId: "acct",
      mainSessionKey: "agent:main:main",
    },
    channelConfig: null,
    replyTarget: "slack://C123",
    ctxPayload: {
      MessageThreadId: "1000.2",
    },
    replyToMode: "first",
    isDirectMessage: false,
    isRoomish: false,
    historyKey: "history",
    preview: "preview",
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  } as unknown as PreparedSlackMessage;
}
