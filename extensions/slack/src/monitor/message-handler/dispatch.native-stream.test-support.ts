import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createReplyDispatcher,
  type GetReplyOptions,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { slackSetupPlugin } from "../../channel.setup.js";
import type { SlackSendResult } from "../../send.js";
import {
  createDraftStreamStub,
  emitSlackToolProgressTestEvent,
  nativeChunks,
  type SlackReplyOptionEvent,
  type TestDispatchSequenceEntry,
  type TestReplyPayload,
} from "./dispatch.compact-progress.test-support.js";
import {
  expectMockCallArgFields,
  requireRecord,
  type DeliveryParams,
} from "./dispatch.preview.test-support.js";

// Native progress streaming through the real dispatcher with the Slack stream
// transport mocked: every start, append and stop is recorded in call order.

export const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const STREAM_MESSAGE_TS = "171234.567";

const mocks = vi.hoisted(() => {
  class TestSlackStreamNotDeliveredError extends Error {
    constructor(
      readonly pendingText: string,
      readonly slackCode: string,
    ) {
      super(`slack-stream not delivered: ${slackCode}`);
      this.name = "SlackStreamNotDeliveredError";
    }
  }
  class TestSlackStreamMessageTooLongError extends TestSlackStreamNotDeliveredError {
    constructor(pendingText: string) {
      super(pendingText, "msg_too_long");
      this.name = "SlackStreamMessageTooLongError";
    }
  }
  return {
    TestSlackStreamNotDeliveredError,
    TestSlackStreamMessageTooLongError,
    appendSlackStream: vi.fn(async (_input?: unknown) => {}),
    startSlackStream: vi.fn(async (_input?: unknown): Promise<Record<string, unknown>> => ({})),
    stopSlackStream: vi.fn(async (_params?: unknown) => ({}) as { messageId?: string }),
    deliverReplies: vi.fn(async (_params: unknown): Promise<unknown> => undefined),
    statusReactionController: {
      setQueued: vi.fn(async () => {}),
      setThinking: vi.fn(async () => {}),
      setTool: vi.fn(async () => {}),
      setError: vi.fn(async () => {}),
      setDone: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      restoreInitial: vi.fn(async () => {}),
    },
  };
});

export const TestSlackStreamMessageTooLongError = mocks.TestSlackStreamMessageTooLongError;
export const appendSlackStreamMock = mocks.appendSlackStream;
export const startSlackStreamMock = mocks.startSlackStream;
export const stopSlackStreamMock = mocks.stopSlackStream;
export const deliverRepliesMock = mocks.deliverReplies as unknown as ReturnType<
  typeof vi.fn<(params: DeliveryParams) => Promise<SlackSendResult | undefined>>
>;

/** Per-test scenario state; reset before every test. */
export const harness = {
  replyThreadTsSequence: undefined as Array<string | undefined> | undefined,
  events: [] as SlackReplyOptionEvent[],
  dispatchSequence: [] as TestDispatchSequenceEntry[],
  capturedReplyOptions: undefined as GetReplyOptions | undefined,
  nativeStreaming: true,
};

const normalDeliveryResult = {
  messageId: "normal-final",
  channelId: "C123",
  receipt: createMessageReceiptFromOutboundResults({
    results: [{ messageId: "normal-final", channelId: "C123" }],
  }),
};

function createNativeStreamSession() {
  return { channel: "C123", threadTs: THREAD_TS, stopped: false, delivered: true, pendingText: "" };
}

// mock-isolation: No human-like delay between scripted replies.
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

// mock-isolation: Keep status reactions local to this dispatch fixture.
vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  createStatusReactionController: () => mocks.statusReactionController,
  logAckFailure: () => {},
  logTypingFailure: () => {},
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelProgressDraftCompositor: (
      params: Parameters<typeof actual.createChannelProgressDraftCompositor>[0],
    ) =>
      actual.createChannelProgressDraftCompositor({
        ...params,
        // Gate timing lives in the compositor suite; these tests exercise the
        // Slack stream after work admits the draft.
        setTimeoutFn: ((handler: () => void) => {
          handler();
          return 0 as never;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => {}) as typeof clearTimeout,
      }),
    createChannelMessageReplyPipeline: (params: {
      transformReplyPayload?: (payload: TestReplyPayload) => TestReplyPayload | null;
    }) => ({
      typingCallbacks: undefined,
      transformReplyPayload: params.transformReplyPayload,
      onModelSelected: undefined,
    }),
    resolveAgentOutboundIdentity: () => undefined,
    resolveChannelStreamingBlockEnabled: () => false,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  danger: (message: string) => message,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: () => undefined,
}));

// mock-isolation: No pinned DM owner; routing stays out of these stream scenarios.
vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("../../actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions.js")>()),
  reactSlackMessage: vi.fn(async () => {}),
  removeSlackReaction: vi.fn(async () => {}),
}));

// mock-isolation: Keep draft transport effects inside the per-test stream fixtures.
vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: () => createDraftStreamStub(),
}));

// mock-isolation: Fixed limits keep oversized-final scenarios independent of runtime config.
vi.mock("../../limits.js", () => ({ SLACK_TEXT_LIMIT: 4000, SLACK_EDIT_TEXT_MAX_BYTES: 4000 }));

// mock-isolation: Thread participation state must not leak between scenarios.
vi.mock("../../sent-thread-cache.js", () => ({
  clearSlackThreadFailureNotice: () => {},
  hasSlackThreadParticipation: () => false,
  recordSlackThreadFailureNotice: () => true,
  recordSlackThreadParticipation: () => {},
}));

// mock-isolation: Fixed progress mode and append-only narration deltas for every scenario.
vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
  resolveSlackStreamingConfig: () => ({
    mode: "progress",
    nativeStreaming: harness.nativeStreaming,
  }),
}));

// mock-isolation: The Slack stream transport is the recorded boundary under test.
vi.mock("../../streaming.js", () => ({
  markSlackStreamFallbackDelivered: (session: {
    delivered: boolean;
    pendingText: string;
    stopped: boolean;
  }) => {
    session.pendingText = "";
    session.stopped = !session.delivered;
  },
  SlackStreamMessageTooLongError: mocks.TestSlackStreamMessageTooLongError,
  SlackStreamNotDeliveredError: mocks.TestSlackStreamNotDeliveredError,
  appendSlackStream: mocks.appendSlackStream,
  startSlackStream: async (input: unknown) =>
    Object.assign(await mocks.startSlackStream(input), { streamer: { ts: STREAM_MESSAGE_TS } }),
  stopSlackStream: async (params: { session: { stopped: boolean } }) => {
    params.session.stopped = true;
    return await mocks.stopSlackStream(params);
  },
}));

// mock-isolation: Message-sent hooks have their own suite.
vi.mock("../../message-sent-hook.js", () => ({ emitSlackMessageSentHooks: () => {} }));

// mock-isolation: Every scenario replies in one fixed thread.
vi.mock("../../threading.js", () => ({
  resolveSlackThreadContext: () => ({ messageThreadId: THREAD_TS, isThreadReply: true }),
}));

vi.mock("../replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../replies.js")>()),
  createSlackReplyDeliveryPlan: () => ({
    peekThreadTs: () =>
      harness.replyThreadTsSequence ? harness.replyThreadTsSequence[0] : THREAD_TS,
    nextThreadTs: () =>
      harness.replyThreadTsSequence ? harness.replyThreadTsSequence.shift() : THREAD_TS,
    markSent: () => {},
  }),
  deliverReplies: (params: Parameters<typeof import("../replies.js").deliverReplies>[0]) =>
    mocks.deliverReplies({
      ...params,
      replies: params.replies.map((prepared) => prepared.payload),
    }),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  return {
    ...actual,
    readAgentRunTerminalOutcome: () => undefined,
    dispatchChannelInboundTurn: async (params: DispatchParams) => {
      const reply = params.replyOptions as GetReplyOptions | undefined;
      harness.capturedReplyOptions = reply;
      for (const [index, entry] of harness.events.entries()) {
        if (entry.kind === "item") {
          const { kind: _kind, itemKind, ...payload } = entry;
          await reply?.onItemEvent?.({ ...payload, kind: itemKind });
        } else if (entry.kind === "command_output" || entry.kind === "tool_start") {
          await emitSlackToolProgressTestEvent(reply, entry, index);
        } else if (entry.kind === "plan") {
          const { kind: _kind, ...payload } = entry;
          await reply?.onPlanUpdate?.(payload);
        } else if (entry.kind === "assistant_start") {
          await reply?.onAssistantMessageStart?.();
        } else if (entry.kind === "reasoning") {
          const { kind: _kind, ...payload } = entry;
          await reply?.onReasoningStream?.(payload);
        } else if (entry.kind === "reasoning_end") {
          await reply?.onReasoningEnd?.();
        } else if (entry.kind === "checkpoint") {
          await entry.run();
        } else {
          throw new Error(`Unsupported test event: ${entry.kind}`);
        }
      }
      const counts = { tool: 0, block: 0, final: 0 };
      for (const entry of harness.dispatchSequence) {
        if (entry.kind === "checkpoint") {
          await entry.run();
          continue;
        }
        if (entry.kind === "queued_followup") {
          await reply?.onQueuedFollowupAdmitted?.();
          continue;
        }
        if (entry.kind === "item") {
          await reply?.onItemEvent?.({ progressText: entry.progressText });
          continue;
        }
        const payload = entry.payload as ReplyPayload;
        counts[entry.kind] += 1;
        const dispatcher = createReplyDispatcher({
          deliver: params.delivery.deliver,
          onError: params.delivery.onError,
        });
        if (entry.kind === "tool") {
          dispatcher.sendToolResult(payload);
        } else if (entry.kind === "block") {
          dispatcher.sendBlockReply(payload);
        } else {
          dispatcher.sendFinalReply(payload);
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
      return {
        admission: { kind: "dispatch" } as const,
        dispatched: true as const,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: { queuedFinal: false, counts, observedReplyDelivery: false },
      };
    },
  };
});

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

function createPreparedSlackMessage(params: {
  accountConfig: Record<string, unknown>;
  replyToMode?: "off" | "first" | "all" | "batched";
}) {
  const message = { channel: "C123", ts: "171234.111", thread_ts: THREAD_TS, user: "U00000000" };
  return {
    ctx: {
      cfg: {},
      runtime: {},
      botToken: "xoxb-test",
      app: { client: { chat: {} } },
      teamId: "T00000000",
      botUserId: "U_OPENCLAW",
      botId: "B_OPENCLAW",
      textLimit: 4000,
      typingReaction: "",
      historyLimit: 0,
      allowFrom: [],
      setSlackSessionStatus: async () => true,
    },
    account: { accountId: "default", config: params.accountConfig },
    message,
    route: {
      agentId: "agent-1",
      accountId: "default",
      mainSessionKey: "main",
      sessionKey: "agent:agent-1:slack:C123",
      lastRoutePolicy: "session",
    },
    channelConfig: null,
    replyTarget: `channel:${message.channel}`,
    ctxPayload: { MessageThreadId: THREAD_TS },
    turn: { record: {} },
    replyToMode: params.replyToMode ?? "all",
    isDirectMessage: false,
    isRoomish: false,
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  } as never;
}

export async function dispatchNativeProgressScenario(params: {
  events: SlackReplyOptionEvent[];
  finalPayload?: TestReplyPayload;
  /** Reply payloads dispatched after the events and before the final. */
  replies?: TestDispatchSequenceEntry[];
  progress?: Record<string, unknown>;
  replyToMode?: "off" | "first" | "all" | "batched";
}) {
  harness.dispatchSequence = [
    ...(params.replies ?? []),
    ...(params.finalPayload === undefined
      ? []
      : [{ kind: "final" as const, payload: params.finalPayload }]),
  ];
  harness.events = params.events;
  await dispatchPreparedSlackMessage(
    createPreparedSlackMessage({
      replyToMode: params.replyToMode,
      accountConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, ...(params.progress ?? { nativeTaskCards: true }) },
        },
      },
    }),
  );
}

export function collectNativeTaskUpdates() {
  return nativeChunks([
    ...startSlackStreamMock.mock.calls,
    ...appendSlackStreamMock.mock.calls,
    ...stopSlackStreamMock.mock.calls,
  ]).filter((chunk) => chunk.type === "task_update");
}

export function expectNativeStreamText(text: string, count = 1) {
  const matches = [...startSlackStreamMock.mock.calls, ...appendSlackStreamMock.mock.calls].filter(
    (call) => requireRecord(call[0], "native stream call").text === text,
  );
  expect(matches).toHaveLength(count);
}

export function expectNativeProgressStart(chunks: unknown[]) {
  expectMockCallArgFields(startSlackStreamMock, 0, {
    channel: "C123",
    threadTs: THREAD_TS,
    taskDisplayMode: "plan",
    chunks,
  });
}

export function expectNativeProgressAppend(index: number, chunks: unknown[]) {
  expectMockCallArgFields(appendSlackStreamMock, index, { chunks });
}

export function expectDeliverReplyCall(index: number, text: string) {
  const params = requireRecord(deliverRepliesMock.mock.calls[index]?.[0], "deliverReplies call");
  expect(params.replyThreadTs).toBe(THREAD_TS);
  expect(params.replies).toEqual([{ text }]);
}

export function sleepRealMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeAll(async () => {
  ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
});

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackSetupPlugin }]),
  );
  harness.replyThreadTsSequence = undefined;
  harness.events = [];
  harness.dispatchSequence = [];
  harness.capturedReplyOptions = undefined;
  harness.nativeStreaming = true;
  appendSlackStreamMock.mockReset().mockResolvedValue(undefined);
  startSlackStreamMock.mockReset().mockResolvedValue(createNativeStreamSession());
  stopSlackStreamMock.mockReset().mockResolvedValue({});
  deliverRepliesMock.mockReset().mockResolvedValue(normalDeliveryResult);
});

afterEach(() => {
  vi.useRealTimers();
  resetPluginRuntimeStateForTest();
});
