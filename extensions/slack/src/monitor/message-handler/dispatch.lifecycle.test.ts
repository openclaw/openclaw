/**
 * Lifecycle tests for dispatchPreparedSlackMessage.
 *
 * Verifies that markRunComplete() is called before markDispatchIdle() in both
 * the normal dispatch path and the onPreDispatchFailure path (issue #84049).
 *
 * Background: Slack's typing/status indicator was not clearing on doneHoldMs
 * because markRunComplete() was never called. Core typing cleanup requires
 * both run-complete and dispatch-idle state. Without markRunComplete(), Slack
 * waited for the fallback TTL (~2 minutes) instead of doneHoldMs.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mutable state for mock control
// ---------------------------------------------------------------------------

let mockedDispatchSequence: Array<{
  kind: "tool" | "block" | "final";
  payload: { text?: string };
}> = [{ kind: "final", payload: { text: "hello" } }];

let shouldPreDispatchFail = false;

const deliverRepliesMock = vi.fn(async () => {});
const postMessageMock = vi.fn(async () => ({ ts: "ts-1", channel: "C123" }));
const recordInboundSessionMock = vi.fn(async () => {});
const updateLastRouteMock = vi.fn(async () => {});
const runPreparedInboundReplyTurnMock = vi.fn();

// ---------------------------------------------------------------------------
// Lifecycle tracking for markRunComplete / markDispatchIdle
// ---------------------------------------------------------------------------

const callOrder: string[] = [];
let markRunCompleteMock: vi.MockedFunction<() => void>;
let markDispatchIdleMock: vi.MockedFunction<() => void>;

// ---------------------------------------------------------------------------
// vi.mock calls (hoisted — must be at top level)
// ---------------------------------------------------------------------------

vi.mock("../reply.runtime.js", () => ({
  createReplyDispatcherWithTyping: (_params: Record<string, unknown>) => ({
    dispatcher: {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      markComplete: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    },
    replyOptions: {},
    markDispatchIdle: () => {
      markDispatchIdleMock?.();
      callOrder.push("markDispatchIdle");
    },
    markRunComplete: () => {
      markRunCompleteMock?.();
      callOrder.push("markRunComplete");
    },
  }),
  dispatchInboundMessage: async (_params: Record<string, unknown>) => {
    return {
      queuedFinal: false,
      counts: { final: mockedDispatchSequence.filter((e) => e.kind === "final").length },
    };
  },
  settleReplyDispatcher: async (params: {
    dispatcher: { markComplete: () => void; waitForIdle: () => Promise<void> };
    onSettled?: () => void | Promise<void>;
  }) => {
    params.dispatcher.markComplete();
    await params.dispatcher.waitForIdle();
    await params.onSettled?.();
  },
}));

vi.mock("openclaw/plugin-sdk/inbound-reply-dispatch", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/inbound-reply-dispatch")
  >("openclaw/plugin-sdk/inbound-reply-dispatch");
  return {
    ...actual,
    runPreparedInboundReplyTurn: (params: {
      onPreDispatchFailure?: () => Promise<void>;
      runDispatch: () => Promise<unknown>;
    }) => runPreparedInboundReplyTurnMock(params),
    hasVisibleInboundReplyDispatch: actual.hasVisibleInboundReplyDispatch,
  };
});

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: () => ({
    nextThreadTs: () => "thread-1",
    peekThreadTs: () => "thread-1",
    markSent: vi.fn(),
  }),
  deliverReplies: deliverRepliesMock,
  readSlackReplyBlocks: () => undefined,
  resolveDeliveredSlackReplyThreadTs: () => "thread-1",
  resolveSlackThreadTs: () => "thread-1",
}));

vi.mock("../conversation.runtime.js", () => ({
  recordInboundSession: recordInboundSessionMock,
}));

vi.mock("../config.runtime.js", () => ({
  resolveStorePath: () => "/tmp/store",
  updateLastRoute: updateLastRouteMock,
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({
    statusThreadTs: "thread-1",
    isThreadReply: false,
  }),
}));

vi.mock("../../streaming.js", () => ({
  startSlackStream: vi.fn(async () => ({
    channel: "C123",
    threadTs: "thread-1",
    stopped: false,
    delivered: true,
    pendingText: "",
  })),
  appendSlackStream: vi.fn(async () => {}),
  stopSlackStream: vi.fn(async () => {}),
  markSlackStreamFallbackDelivered: vi.fn(),
  SlackStreamNotDeliveredError: class SlackStreamNotDeliveredError extends Error {
    slackCode: string;
    pendingText: string;
    constructor(pendingText: string, slackCode: string) {
      super("not delivered");
      this.slackCode = slackCode;
      this.pendingText = pendingText;
    }
  },
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: vi.fn(),
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: vi.fn(async () => {}),
  removeSlackReaction: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-feedback")>(
    "openclaw/plugin-sdk/channel-feedback",
  );
  return {
    ...actual,
    createStatusReactionController: () => ({
      setQueued: vi.fn(async () => {}),
      setThinking: vi.fn(async () => {}),
      setTool: vi.fn(async () => {}),
      setDone: vi.fn(async () => {}),
      setError: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      restoreInitial: vi.fn(async () => {}),
    }),
    removeAckReactionAfterReply: vi.fn(async () => {}),
  };
});

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/outbound-runtime", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-message", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-message")>(
    "openclaw/plugin-sdk/channel-message",
  );
  return {
    ...actual,
    createChannelMessageReplyPipeline: () => ({
      onModelSelected: vi.fn(),
      typingCallbacks: { onIdle: vi.fn() },
      typing: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        onStartError: vi.fn(),
        onStopError: vi.fn(),
      },
    }),
  };
});

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

function createPreparedSlackMessage() {
  return {
    ctx: {
      cfg: {},
      runtime: {},
      botToken: "xoxb-test",
      app: { client: { chat: { postMessage: postMessageMock }, users: { info: vi.fn() } } },
      teamId: "T1",
      botUserId: "U_OPENCLAW",
      botId: "B_OPENCLAW",
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
      sessionKey: "agent:agent-1:slack:C123",
      lastRoutePolicy: "session",
    },
    channelConfig: null,
    replyToMode: "first" as const,
    isDirectMessage: false,
    replyTarget: "C123",
    forcedReplyThreadTs: undefined,
    slackMessageMetadata: undefined,
    ackReactionMessageTs: undefined,
    ackReactionPromise: null,
    ackReactionValue: "eyes",
    ctxPayload: {
      MessageThreadId: undefined,
      TransportThreadId: undefined,
      SessionKey: undefined,
    },
    turn: {
      storePath: "/tmp/store",
      record: {},
      history: [],
    },
  } as unknown as Parameters<
    typeof import("./dispatch.js").dispatchPreparedSlackMessage
  >[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

describe("dispatchPreparedSlackMessage run lifecycle (issue #84049)", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });

  beforeEach(() => {
    callOrder.length = 0;
    markRunCompleteMock = vi.fn();
    markDispatchIdleMock = vi.fn();
    mockedDispatchSequence = [{ kind: "final", payload: { text: "hello" } }];
    shouldPreDispatchFail = false;
    deliverRepliesMock.mockReset();
    deliverRepliesMock.mockResolvedValue(undefined);

    // Default: normal successful dispatch
    runPreparedInboundReplyTurnMock.mockImplementation(
      async (params: {
        onPreDispatchFailure?: () => Promise<void>;
        runDispatch: () => Promise<unknown>;
      }) => {
        const result = await params.runDispatch();
        return { dispatched: true, dispatchResult: result };
      },
    );
  });

  it("calls markRunComplete before markDispatchIdle on normal dispatch completion", async () => {
    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(markRunCompleteMock).toHaveBeenCalledTimes(1);
    expect(markDispatchIdleMock).toHaveBeenCalledTimes(1);

    const rcIndex = callOrder.indexOf("markRunComplete");
    const idleIndex = callOrder.indexOf("markDispatchIdle");
    expect(rcIndex).toBeGreaterThanOrEqual(0);
    expect(idleIndex).toBeGreaterThanOrEqual(0);
    expect(rcIndex).toBeLessThan(idleIndex);
  });

  it("calls markRunComplete before markDispatchIdle when onPreDispatchFailure fires", async () => {
    runPreparedInboundReplyTurnMock.mockImplementation(
      async (params: {
        onPreDispatchFailure?: () => Promise<void>;
        runDispatch: () => Promise<unknown>;
      }) => {
        // Simulate pre-dispatch failure path
        await params.onPreDispatchFailure?.();
        return { dispatched: false };
      },
    );

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(markRunCompleteMock).toHaveBeenCalledTimes(1);
    expect(markDispatchIdleMock).toHaveBeenCalledTimes(1);

    const rcIndex = callOrder.indexOf("markRunComplete");
    const idleIndex = callOrder.indexOf("markDispatchIdle");
    expect(rcIndex).toBeGreaterThanOrEqual(0);
    expect(idleIndex).toBeGreaterThanOrEqual(0);
    expect(rcIndex).toBeLessThan(idleIndex);
  });

  it("calls markRunComplete and markDispatchIdle exactly once on successful dispatch", async () => {
    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(markRunCompleteMock).toHaveBeenCalledTimes(1);
    expect(markDispatchIdleMock).toHaveBeenCalledTimes(1);
  });
});
