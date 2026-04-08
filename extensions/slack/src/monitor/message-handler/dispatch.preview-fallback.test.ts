import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const createSlackDraftStreamMock = vi.fn();
const deliverRepliesMock = vi.fn(async () => {});
const finalizeSlackPreviewEditMock = vi.fn(async () => {});

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  DEFAULT_TIMING: {
    doneHoldMs: 0,
    errorHoldMs: 0,
  },
  createStatusReactionController: () => ({
    setQueued: async () => {},
    setThinking: async () => {},
    setTool: async () => {},
    setError: async () => {},
    setDone: async () => {},
    clear: async () => {},
    restoreInitial: async () => {},
  }),
  logAckFailure: () => {},
  logTypingFailure: () => {},
  removeAckReactionAfterReply: () => {},
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: () => ({
    typingCallbacks: {
      onIdle: vi.fn(),
    },
    onModelSelected: undefined,
  }),
}));

vi.mock("openclaw/plugin-sdk/channel-streaming", () => ({
  resolveChannelStreamingBlockEnabled: () => false,
  resolveChannelStreamingNativeTransport: () => false,
}));

vi.mock("openclaw/plugin-sdk/outbound-runtime", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  clearHistoryEntriesIfEnabled: () => {},
}));

vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  resolveSendableOutboundReplyParts: (
    payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
    opts?: { text?: string },
  ) => {
    const text = (opts?.text ?? payload.text ?? "").trim();
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    return {
      text,
      trimmedText: text,
      hasText: text.length > 0,
      hasMedia: mediaUrls.length > 0,
      mediaUrls,
      hasContent: text.length > 0 || mediaUrls.length > 0,
    };
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (message: string) => message,
  logVerbose: () => {},
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalLowercaseString: (value?: string) => value?.toLowerCase(),
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: async () => {},
  removeSlackReaction: async () => {},
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: (...args: unknown[]) =>
    createSlackDraftStreamMock(...(args as Parameters<typeof createSlackDraftStreamMock>)),
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (value: string) => value.trim(),
}));

vi.mock("../../limits.js", () => ({
  SLACK_TEXT_LIMIT: 4000,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: () => {},
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
  buildStatusFinalPreviewText: () => "status",
  resolveSlackStreamingConfig: () => ({
    mode: "partial",
    nativeStreaming: false,
    draftMode: "append",
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: async () => {},
  startSlackStream: async () => ({
    threadTs: "thread-1",
    stopped: false,
  }),
  stopSlackStream: async () => {},
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({
    statusThreadTs: "thread-1",
    isThreadReply: true,
  }),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (value: string) => value,
}));

vi.mock("../config.runtime.js", () => ({
  resolveStorePath: () => "/tmp/openclaw-store.json",
  updateLastRoute: async () => {},
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: () => ({
    nextThreadTs: () => "thread-1",
    markSent: () => {},
  }),
  deliverReplies: (...args: unknown[]) =>
    deliverRepliesMock(...(args as Parameters<typeof deliverRepliesMock>)),
  readSlackReplyBlocks: () => undefined,
  resolveSlackThreadTs: () => "thread-1",
}));

vi.mock("../reply.runtime.js", () => ({
  createReplyDispatcherWithTyping: (params: { deliver: (payload: unknown) => Promise<void> }) => ({
    dispatcher: {
      deliver: params.deliver,
    },
    replyOptions: {},
    markDispatchIdle: () => {},
  }),
  dispatchInboundMessage: async (params: {
    dispatcher: { deliver: (payload: { text: string }) => Promise<void> };
  }) => {
    await params.dispatcher.deliver({ text: "final answer" });
    return {
      queuedFinal: false,
      counts: {
        final: 1,
      },
    };
  },
}));

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: (...args: unknown[]) =>
    finalizeSlackPreviewEditMock(...(args as Parameters<typeof finalizeSlackPreviewEditMock>)),
}));

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

describe("dispatchPreparedSlackMessage preview fallback", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });

  beforeEach(() => {
    createSlackDraftStreamMock.mockReset();
    deliverRepliesMock.mockReset();
    finalizeSlackPreviewEditMock.mockReset();

    createSlackDraftStreamMock.mockReturnValue({
      update: () => {},
      flush: async () => {},
      clear: async () => {},
      stop: () => {},
      forceNewMessage: () => {},
      messageId: () => "171234.567",
      channelId: () => "C123",
      lastText: () => "final answer",
    });
    finalizeSlackPreviewEditMock.mockRejectedValue(new Error("socket closed"));
  });

  it("falls back to normal delivery when preview finalize fails", async () => {
    await dispatchPreparedSlackMessage({
      ctx: {
        cfg: {},
        runtime: {},
        botToken: "xoxb-test",
        app: { client: {} },
        teamId: "T1",
        textLimit: 4000,
        typingReaction: "",
        removeAckAfterReply: false,
        historyLimit: 0,
        channelHistories: new Map(),
        allowFrom: [],
        setSlackThreadStatus: async () => undefined,
      },
      account: {
        accountId: "default",
        config: {},
      },
      message: {
        channel: "C123",
        ts: "171234.111",
        thread_ts: "thread-1",
        user: "U123",
      },
      route: {
        agentId: "agent-1",
        accountId: "default",
        mainSessionKey: "main",
      },
      channelConfig: null,
      replyTarget: "channel:C123",
      ctxPayload: {
        MessageThreadId: "thread-1",
      },
      replyToMode: "all",
      isDirectMessage: false,
      isRoomish: false,
      historyKey: "history-key",
      preview: "",
      ackReactionValue: "eyes",
      ackReactionPromise: null,
    } as never);

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: "thread-1",
        replies: [expect.objectContaining({ text: "final answer" })],
      }),
    );
  });
});
