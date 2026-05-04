import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const startSlackPlanMessageMock = vi.fn(async () => ({
  client: {} as never,
  channel: "D123",
  messageTs: "171234.100",
  tasks: [],
  revision: 1,
  renderMode: "plan" as const,
  stopped: false,
}));
const appendSlackPlanMessageMock = vi.fn(async () => {});
const stopSlackPlanMessageMock = vi.fn(async () => {});
const startSlackChunkStreamMock = vi.fn(async () => ({
  client: {} as never,
  channel: "C123",
  threadTs: "thread-1",
  messageTs: "171234.200",
  stopped: false,
}));
const appendSlackChunkStreamMock = vi.fn(async () => {});
const stopSlackChunkStreamMock = vi.fn(async () => {});
const deliverRepliesMock = vi.fn(async () => {});
const setSlackThreadStatusMock = vi.fn(async () => {});
const setSlackThreadTitleMock = vi.fn(async () => {});

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

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

vi.mock("openclaw/plugin-sdk/channel-lifecycle", () => ({
  deliverFinalizableDraftPreview: async (params: { deliverNormally: () => Promise<void> }) => {
    await params.deliverNormally();
    return "normal-delivery";
  },
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: () => ({
    typingCallbacks: {
      onIdle: vi.fn(),
    },
    onModelSelected: () => {},
  }),
}));

vi.mock("openclaw/plugin-sdk/channel-streaming", () => ({
  resolveChannelStreamingBlockEnabled: () => false,
  resolveChannelStreamingNativeTransport: () => false,
  resolveChannelStreamingPreviewToolProgress: () => true,
}));

vi.mock("openclaw/plugin-sdk/error-runtime", () => ({
  formatErrorMessage: (err: unknown) => String(err),
}));

vi.mock("openclaw/plugin-sdk/outbound-runtime", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/reply-history", () => ({
  clearHistoryEntriesIfEnabled: () => {},
}));

vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  resolveSendableOutboundReplyParts: (payload: { text?: string }) => ({
    text: payload.text ?? "",
    trimmedText: payload.text?.trim() ?? "",
    hasText: Boolean(payload.text?.trim()),
    hasMedia: false,
    mediaUrls: [],
    hasContent: Boolean(payload.text?.trim()),
  }),
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
  createSlackDraftStream: () => undefined,
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (value: string) => value.trim(),
}));

vi.mock("../../interactive-replies.js", () => ({
  compileSlackInteractiveReplies: (payload: unknown) => payload,
  isSlackInteractiveRepliesEnabled: () => false,
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
    mode: "progress",
    nativeStreaming: true,
    draftMode: "status_final",
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: async () => {},
  appendSlackChunkStream: appendSlackChunkStreamMock,
  appendSlackPlanMessage: appendSlackPlanMessageMock,
  markSlackStreamFallbackDelivered: () => {},
  SlackStreamNotDeliveredError: class SlackStreamNotDeliveredError extends Error {},
  startSlackChunkStream: startSlackChunkStreamMock,
  startSlackPlanMessage: startSlackPlanMessageMock,
  startSlackStream: async () => {
    throw new Error("native text stream should stay off in progress mode");
  },
  stopSlackChunkStream: stopSlackChunkStreamMock,
  stopSlackPlanMessage: stopSlackPlanMessageMock,
  stopSlackStream: async () => {},
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: (params: {
    message: { ts?: string; thread_ts?: string };
    replyToMode: "off" | "all";
  }) => {
    const messageTs = params.message.ts;
    const incomingThreadTs = params.message.thread_ts;
    const isThreadReply = Boolean(incomingThreadTs && incomingThreadTs !== messageTs);
    const replyThreadTs = isThreadReply
      ? incomingThreadTs
      : params.replyToMode === "all"
        ? messageTs
        : undefined;
    return {
      statusThreadTs: replyThreadTs,
      replyThreadTs,
      isThreadReply,
    };
  },
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (value: string) => value,
}));

vi.mock("../config.runtime.js", () => ({
  resolveStorePath: () => "/tmp/openclaw-store.json",
  updateLastRoute: async () => {},
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: (params: {
    replyToMode: "off" | "all";
    incomingThreadTs?: string;
    messageTs?: string;
    isThreadReply?: boolean;
  }) => ({
    peekThreadTs: () =>
      params.isThreadReply
        ? params.incomingThreadTs
        : params.replyToMode === "all"
          ? params.messageTs
          : undefined,
    nextThreadTs: () =>
      params.isThreadReply
        ? params.incomingThreadTs
        : params.replyToMode === "all"
          ? params.messageTs
          : undefined,
    markSent: () => {},
  }),
  deliverReplies: deliverRepliesMock,
  readSlackReplyBlocks: () => undefined,
  resolveSlackThreadTs: (params: {
    replyToMode: "off" | "all";
    incomingThreadTs?: string;
    messageTs?: string;
    isThreadReply?: boolean;
  }) =>
    params.isThreadReply
      ? params.incomingThreadTs
      : params.replyToMode === "all"
        ? params.messageTs
        : undefined,
}));

vi.mock("../reply.runtime.js", () => ({
  createReplyDispatcherWithTyping: (params: {
    deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
  }) => ({
    dispatcher: {
      deliver: params.deliver,
    },
    replyOptions: {},
    markDispatchIdle: () => {},
  }),
  dispatchInboundMessage: async (params: {
    replyOptions?: { onAssistantMessageStart?: () => Promise<void> | void };
    dispatcher: {
      deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
    };
  }) => {
    await params.replyOptions?.onAssistantMessageStart?.();
    await params.dispatcher.deliver({ text: "final answer" }, { kind: "final" });
    return {
      queuedFinal: false,
      counts: { final: 1 },
    };
  },
}));

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: async () => "not-finalized",
}));

function createPreparedSlackMessage(params?: {
  channel?: string;
  threadTs?: string;
  replyToMode?: "off" | "all";
  isDirectMessage?: boolean;
  replyTarget?: string;
  text?: string;
}) {
  return {
    ctx: {
      cfg: {},
      runtime: {},
      botToken: "xoxb-test",
      app: {
        client: {
          chat: {
            postMessage: vi.fn(async () => ({ ok: true, ts: "171234.300" })),
          },
          users: {
            info: vi.fn(async () => ({ user: { team_id: "T1" } })),
          },
        },
      },
      teamId: "T1",
      textLimit: 4000,
      typingReaction: "",
      removeAckAfterReply: false,
      historyLimit: 0,
      channelHistories: new Map(),
      allowFrom: [],
      setSlackThreadStatus: setSlackThreadStatusMock,
      setSlackThreadTitle: setSlackThreadTitleMock,
    },
    account: {
      accountId: "default",
      config: {},
    },
    message: {
      channel: params?.channel ?? "C123",
      ts: "171234.111",
      thread_ts: params?.threadTs,
      text: params?.text ?? "Can you access twenty?",
      user: "U123",
    },
    route: {
      agentId: "agent-1",
      accountId: "default",
      mainSessionKey: "main",
    },
    channelConfig: null,
    replyTarget: params?.replyTarget ?? "channel:C123",
    ctxPayload: {
      MessageThreadId: params?.threadTs,
    },
    replyToMode: params?.replyToMode ?? "all",
    isDirectMessage: params?.isDirectMessage ?? false,
    isRoomish: false,
    historyKey: "history-key",
    preview: "",
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  } as never;
}

describe("dispatchPreparedSlackMessage progress plan routing", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });

  beforeEach(() => {
    startSlackPlanMessageMock.mockClear();
    appendSlackPlanMessageMock.mockClear();
    stopSlackPlanMessageMock.mockClear();
    startSlackChunkStreamMock.mockClear();
    appendSlackChunkStreamMock.mockClear();
    stopSlackChunkStreamMock.mockClear();
    deliverRepliesMock.mockClear();
    setSlackThreadStatusMock.mockClear();
    setSlackThreadTitleMock.mockClear();
  });

  it("keeps direct messages off the Slack progress-plan stream surface", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "D123",
        threadTs: "171234.001",
        replyToMode: "off",
        isDirectMessage: true,
        replyTarget: "user:U123",
      }),
    );

    expect(startSlackPlanMessageMock).not.toHaveBeenCalled();
    expect(startSlackChunkStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: "171234.001",
        replyToMode: "off",
      }),
    );
    expect(setSlackThreadTitleMock).not.toHaveBeenCalled();
  });

  it("sets the assistant thread title from the first direct-message prompt", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "D123",
        threadTs: "171234.111",
        replyToMode: "off",
        isDirectMessage: true,
        replyTarget: "user:U123",
      }),
    );

    expect(setSlackThreadTitleMock).toHaveBeenCalledWith({
      channelId: "D123",
      threadTs: "171234.111",
      title: "Can you access twenty?",
    });
  });

  it("keeps threaded room progress on Slack's native plan stream surface", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "C123",
        threadTs: "thread-1",
        replyToMode: "all",
        isDirectMessage: false,
        replyTarget: "channel:C123",
      }),
    );

    expect(startSlackChunkStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        threadTs: "thread-1",
        taskDisplayMode: "plan",
      }),
    );
    expect(startSlackPlanMessageMock).not.toHaveBeenCalled();
  });
});
