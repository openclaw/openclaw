import { describe, expect, it, vi } from "vitest";
import { dispatchPreparedSlackMessage } from "./dispatch.js";
import type { PreparedSlackMessage } from "./types.js";

// Spy on updateLastRoute to assert it is/isn't called with the main session key.
const updateLastRouteSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  DEFAULT_TIMING: { doneHoldMs: 0, errorHoldMs: 0 },
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
  deliverFinalizableDraftPreview: async () => "normal",
}));

vi.mock("openclaw/plugin-sdk/channel-reply-pipeline", () => ({
  createChannelReplyPipeline: () => ({
    typingCallbacks: { onIdle: vi.fn() },
    onModelSelected: undefined,
  }),
  resolveChannelSourceReplyDeliveryMode: () => "normal",
}));

vi.mock("openclaw/plugin-sdk/channel-streaming", () => ({
  resolveChannelStreamingBlockEnabled: () => false,
  resolveChannelStreamingNativeTransport: () => false,
  resolveChannelStreamingPreviewToolProgress: () => false,
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
  resolveSendableOutboundReplyParts: () => ({
    text: "reply",
    trimmedText: "reply",
    hasText: true,
    hasMedia: false,
    mediaUrls: [],
    hasContent: true,
  }),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (m: string) => m,
  logVerbose: () => {},
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  normalizeOptionalLowercaseString: (v?: string) => v?.toLowerCase(),
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: async () => {},
  removeSlackReaction: async () => {},
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: () => ({
    update: () => {},
    flush: async () => {},
    clear: async () => {},
    discardPending: async () => {},
    seal: async () => {},
    forceNewMessage: () => {},
    messageId: () => undefined,
    channelId: () => undefined,
  }),
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (v: string) => v.trim(),
}));

vi.mock("../../interactive-replies.js", () => ({
  compileSlackInteractiveReplies: (p: unknown) => p,
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
    mode: "off",
    nativeStreaming: false,
    draftMode: "append",
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: async () => {},
  markSlackStreamFallbackDelivered: () => {},
  SlackStreamNotDeliveredError: class SlackStreamNotDeliveredError extends Error {
    pendingText: string;
    slackCode: string;
    constructor(pendingText: string, slackCode: string) {
      super(`not-delivered: ${slackCode}`);
      this.pendingText = pendingText;
      this.slackCode = slackCode;
    }
  },
  startSlackStream: async () => ({
    channel: "C123",
    threadTs: "100.000",
    stopped: false,
    delivered: true,
    pendingText: "",
  }),
  stopSlackStream: async () => {},
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({
    statusThreadTs: undefined,
    isThreadReply: false,
  }),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (v: string) => v,
}));

vi.mock("../config.runtime.js", () => ({
  resolveStorePath: () => "/tmp/test-store.json",
  updateLastRoute: updateLastRouteSpy,
}));

vi.mock("../mrkdwn.js", () => ({
  escapeSlackMrkdwn: (v: string) => v,
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: () => ({
    peekThreadTs: () => undefined,
    nextThreadTs: () => undefined,
    markSent: () => {},
  }),
  deliverReplies: async () => {},
  readSlackReplyBlocks: () => undefined,
  resolveDeliveredSlackReplyThreadTs: () => undefined,
  resolveSlackThreadTs: () => undefined,
}));

vi.mock("../reply.runtime.js", () => ({
  createReplyDispatcherWithTyping: (params: {
    deliver: (payload: unknown, info: { kind: string }) => Promise<void>;
  }) => ({
    dispatcher: { deliver: params.deliver },
    replyOptions: {},
    markDispatchIdle: () => {},
  }),
  dispatchInboundMessage: async () => ({
    queuedFinal: false,
    counts: { final: 1, block: 0 },
  }),
}));

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: async () => {},
}));

function buildDmPreparedMessage(
  params: {
    dmScope?: string;
    routeSessionKey?: string;
    lastRoutePolicy?: "main" | "session";
  } = {},
): PreparedSlackMessage {
  const routeSessionKey =
    params.routeSessionKey ??
    (params.dmScope && params.dmScope !== "main"
      ? "agent:main:slack:default:direct:ua1"
      : "agent:main:main");
  const lastRoutePolicy =
    params.lastRoutePolicy ?? (routeSessionKey === "agent:main:main" ? "main" : "session");
  return {
    ctx: {
      cfg: {
        session: params.dmScope !== undefined ? { dmScope: params.dmScope } : {},
      },
      runtime: { error: undefined },
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
      channel: "D123",
      ts: "1.000",
      user: "UA1",
    },
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: routeSessionKey,
      mainSessionKey: "agent:main:main",
      lastRoutePolicy,
      channel: "slack",
      matchedBy: "default",
    },
    channelConfig: null,
    replyTarget: "channel:D123",
    ctxPayload: {
      MessageThreadId: undefined,
    },
    turn: {
      storePath: "/tmp/test-store.json",
      record: {},
    },
    replyToMode: "off",
    isDirectMessage: true,
    isRoomish: false,
    historyKey: "slack:D123",
    preview: "hello",
    ackReactionValue: "",
    ackReactionPromise: null,
  } as never;
}

type UpdateLastRouteCall = [{ sessionKey?: string }];

function countMainSessionRouteUpdates(): number {
  const calls = updateLastRouteSpy.mock.calls as unknown as UpdateLastRouteCall[];
  return calls.filter((call) => call[0]?.sessionKey === "agent:main:main").length;
}

describe("slack dispatchPreparedSlackMessage: dmScope gate for main-session route", () => {
  it("does not call updateLastRoute for main session when dmScope is per-channel-peer", async () => {
    updateLastRouteSpy.mockClear();
    await dispatchPreparedSlackMessage(buildDmPreparedMessage({ dmScope: "per-channel-peer" }));

    expect(countMainSessionRouteUpdates()).toBe(0);
  });

  it("does not call updateLastRoute for main session when dmScope is per-peer", async () => {
    updateLastRouteSpy.mockClear();
    await dispatchPreparedSlackMessage(buildDmPreparedMessage({ dmScope: "per-peer" }));

    expect(countMainSessionRouteUpdates()).toBe(0);
  });

  it("does not call updateLastRoute for main session when dmScope is per-account-channel-peer", async () => {
    updateLastRouteSpy.mockClear();
    await dispatchPreparedSlackMessage(
      buildDmPreparedMessage({ dmScope: "per-account-channel-peer" }),
    );

    expect(countMainSessionRouteUpdates()).toBe(0);
  });

  it("calls updateLastRoute for main session when dmScope is main", async () => {
    updateLastRouteSpy.mockClear();
    await dispatchPreparedSlackMessage(buildDmPreparedMessage({ dmScope: "main" }));

    expect(countMainSessionRouteUpdates()).toBe(1);
  });

  it("calls updateLastRoute for main session when dmScope is unset (default behavior)", async () => {
    updateLastRouteSpy.mockClear();
    await dispatchPreparedSlackMessage(buildDmPreparedMessage());

    expect(countMainSessionRouteUpdates()).toBe(1);
  });
  it("honors binding-level dmScope overrides even when global dmScope is main", async () => {
    updateLastRouteSpy.mockClear();
    await dispatchPreparedSlackMessage(
      buildDmPreparedMessage({
        dmScope: "main",
        routeSessionKey: "agent:main:slack:default:direct:ua1",
        lastRoutePolicy: "session",
      }),
    );

    expect(countMainSessionRouteUpdates()).toBe(0);
    expect(updateLastRouteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:slack:default:direct:ua1" }),
    );
  });
});
