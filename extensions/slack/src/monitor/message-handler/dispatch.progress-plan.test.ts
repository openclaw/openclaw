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
let dispatchInboundMessageImpl: (params: {
  replyOptions?: {
    suppressDefaultToolProgressMessages?: boolean;
    onAssistantMessageStart?: () => Promise<void> | void;
    onModelSelected?: (modelCtx: unknown) => void;
    onItemEvent?: (payload: {
      itemId?: string;
      kind?: string;
      phase?: string;
      status?: string;
      title?: string;
      name?: string;
    }) => Promise<void> | void;
  };
  dispatcher: {
    deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
  };
}) => Promise<{
  queuedFinal: boolean;
  counts: { final: number };
}>;

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
    replyOptions?: {
      onAssistantMessageStart?: () => Promise<void> | void;
      onModelSelected?: (modelCtx: unknown) => void;
      onItemEvent?: (payload: {
        itemId?: string;
        kind?: string;
        phase?: string;
        status?: string;
        title?: string;
        name?: string;
      }) => Promise<void> | void;
    };
    dispatcher: {
      deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
    };
  }) => dispatchInboundMessageImpl(params),
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
  allowDirectMessagePlanStream?: boolean;
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
      AllowDirectMessagePlanStream: params?.allowDirectMessagePlanStream ?? false,
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

function collectProgressTaskUpdates() {
  return [
    ...startSlackChunkStreamMock.mock.calls.flatMap((call) => call[0]?.chunks ?? []),
    ...appendSlackChunkStreamMock.mock.calls.flatMap((call) => call[0]?.chunks ?? []),
  ].filter(
    (chunk): chunk is { type: "task_update"; id: string; title: string; status: string } =>
      chunk?.type === "task_update",
  );
}

describe("dispatchPreparedSlackMessage progress plan routing", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });

  beforeEach(() => {
    dispatchInboundMessageImpl = async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.dispatcher.deliver({ text: "final answer" }, { kind: "final" });
      return {
        queuedFinal: false,
        counts: { final: 1 },
      };
    };
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

  it("uses Slack native plan task cards for canonical direct-message threads", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "D123",
        threadTs: "dm-thread-1",
        replyToMode: "all",
        isDirectMessage: true,
        replyTarget: "user:U123",
        allowDirectMessagePlanStream: true,
      }),
    );

    expect(startSlackChunkStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123",
        threadTs: "dm-thread-1",
        taskDisplayMode: "plan",
      }),
    );
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: "dm-thread-1",
        replyToMode: "all",
      }),
    );
  });

  it("uses native plan task cards for live human-authored DMs when direct reply mode threads all replies", async () => {
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "D0ATM6792E7",
        threadTs: "1777974480.000100",
        replyToMode: "all",
        isDirectMessage: true,
        replyTarget: "channel:D0ATM6792E7",
        text: "DM-PROGRESS-TEST-2026-05-05-0948",
        allowDirectMessagePlanStream: false,
      }),
    );

    expect(startSlackChunkStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D0ATM6792E7",
        threadTs: "1777974480.000100",
        taskDisplayMode: "plan",
      }),
    );
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyThreadTs: "1777974480.000100",
        replyToMode: "all",
      }),
    );
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

  it("keeps default status progress messages available while native progress-plan streaming is active", async () => {
    dispatchInboundMessageImpl = async (params) => {
      expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.dispatcher.deliver({ text: "final answer" }, { kind: "final" });
      return {
        queuedFinal: false,
        counts: { final: 1 },
      };
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "C123",
        threadTs: "thread-1",
        replyToMode: "all",
        isDirectMessage: false,
        replyTarget: "channel:C123",
      }),
    );

    expect(startSlackChunkStreamMock).toHaveBeenCalled();
  });

  it("prefers human-readable tool task cards once concrete tool events arrive", async () => {
    dispatchInboundMessageImpl = async (params) => {
      params.replyOptions?.onModelSelected?.({});
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool-web-1",
        kind: "tool",
        phase: "start",
        status: "running",
        title: "web_search",
        name: "web_search",
      });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool-web-1",
        kind: "tool",
        phase: "end",
        status: "completed",
        title: "web_search",
        name: "web_search",
      });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool-exec-1",
        kind: "tool",
        phase: "start",
        status: "running",
        title: "exec",
        name: "exec",
      });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool-exec-1",
        kind: "tool",
        phase: "end",
        status: "completed",
        title: "exec",
        name: "exec",
      });
      await params.dispatcher.deliver({ text: "final answer" }, { kind: "final" });
      return {
        queuedFinal: false,
        counts: { final: 1 },
      };
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "C123",
        threadTs: "thread-1",
        replyToMode: "all",
        isDirectMessage: false,
        replyTarget: "channel:C123",
      }),
    );

    expect(collectProgressTaskUpdates()).toEqual(
      expect.arrayContaining([
        {
          type: "task_update",
          id: "reading_message",
          title: "Reading message",
          status: "in_progress",
        },
        {
          type: "task_update",
          id: "tool_web_1",
          title: "Searching the web",
          status: "in_progress",
        },
        {
          type: "task_update",
          id: "tool_exec_1",
          title: "Running command",
          status: "in_progress",
        },
      ]),
    );

    const updates = collectProgressTaskUpdates();
    const decisionCompleteIndex = updates.findIndex(
      (chunk) => chunk.id === "deciding_next_steps" && chunk.status === "complete",
    );
    const webStartIndex = updates.findIndex(
      (chunk) =>
        chunk.id === "tool_web_1" &&
        chunk.title === "Searching the web" &&
        chunk.status === "in_progress",
    );
    const execStartIndex = updates.findIndex(
      (chunk) => chunk.id === "tool_exec_1" && chunk.status === "in_progress",
    );
    const execCompleteIndex = updates.findIndex(
      (chunk) => chunk.id === "tool_exec_1" && chunk.status === "complete",
    );
    const sendStartIndex = updates.findIndex(
      (chunk) => chunk.id === "sending_reply" && chunk.status === "in_progress",
    );

    expect(decisionCompleteIndex).toBeGreaterThan(-1);
    expect(webStartIndex).toBeLessThan(decisionCompleteIndex);
    expect(execStartIndex).toBeGreaterThan(-1);
    expect(execCompleteIndex).toBeGreaterThan(-1);
    expect(sendStartIndex).toBeGreaterThan(execCompleteIndex);
  });

  it("marks failed tool cards as errors before sending the reply", async () => {
    dispatchInboundMessageImpl = async (params) => {
      params.replyOptions?.onModelSelected?.({});
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool-linear-1",
        kind: "tool",
        phase: "start",
        status: "running",
        title: "linear issue search",
        name: "linear_search",
      });
      await params.replyOptions?.onItemEvent?.({
        itemId: "tool-linear-1",
        kind: "tool",
        phase: "end",
        status: "failed",
        title: "linear issue search",
        name: "linear_search",
      });
      await params.dispatcher.deliver({ text: "final answer" }, { kind: "final" });
      return {
        queuedFinal: false,
        counts: { final: 1 },
      };
    };

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        channel: "C123",
        threadTs: "thread-1",
        replyToMode: "all",
        isDirectMessage: false,
        replyTarget: "channel:C123",
      }),
    );

    const updates = collectProgressTaskUpdates();
    const linearErrorIndex = updates.findIndex(
      (chunk) =>
        chunk.id === "tool_linear_1" && chunk.title === "Using Linear" && chunk.status === "error",
    );
    const sendStartIndex = updates.findIndex(
      (chunk) => chunk.id === "sending_reply" && chunk.status === "in_progress",
    );

    expect(linearErrorIndex).toBeGreaterThan(-1);
    expect(sendStartIndex).toBeGreaterThan(linearErrorIndex);
  });
});
