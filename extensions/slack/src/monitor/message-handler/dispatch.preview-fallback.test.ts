import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  projectAgentToolActivity,
  projectProgressCardChannelUpdate,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createReplyDispatcher,
  finalizeInboundContext,
  type GetReplyOptions,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildSlackCompleteBlocksFallbackText } from "../../blocks-fallback.js";
import { slackSetupPlugin } from "../../channel.setup.js";
import type { SlackSendResult } from "../../send.js";
import { getSlackSessionRuns } from "../session-run-targets.js";
import {
  checkpoint,
  nativeChunks,
  createDraftStreamStub,
  noopAsync,
  preamble,
  approval,
  toolStart,
  finalReply,
  presentation,
  planEvent,
  textReply,
  section,
  workSession,
  ttsPayload,
  expectNoCalls,
  expectCalls,
  contentTaskId,
  emitCompactProgressScenario,
  expectRecordFields,
  planUpdate,
  requireMockCall,
  taskUpdate,
  type SlackReplyOptionEvent,
  type TestReplyPayload,
  type TestDispatchCounts,
  type TestDispatchSequenceEntry,
} from "./dispatch.compact-progress.test-support.js";
import {
  createSlackPlatformError,
  expectMockCallArgFields,
  requireRecord,
  type DeliveryParams,
} from "./dispatch.preview.test-support.js";
import type { PreparedSlackMessage } from "./types.js";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const STREAM_MESSAGE_TS = "171234.567";
const SAME_TEXT = "same reply";
const PROGRESS_LINK_CONFIG = {
  gateway: { publicOrigin: "https://team.openclaw.ai", controlUi: { basePath: "/openclaw" } },
};
const HUMAN_THREAD_REPLY = {
  accountId: "default",
  channelId: "C123",
  threadTs: THREAD_TS,
  messageTs: "171234.568",
  userId: "U_HUMAN",
};

const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());
const createSlackDraftStreamMock = vi.fn();
const normalDeliveryResult = {
  messageId: "normal-final",
  channelId: "C123",
  receipt: createMessageReceiptFromOutboundResults({
    results: [{ messageId: "normal-final", channelId: "C123" }],
  }),
};
const deliverRepliesMock = vi.fn(
  async (_params: DeliveryParams): Promise<SlackSendResult | undefined> => normalDeliveryResult,
);
const sendMessageSlackMock = vi.fn<typeof import("../../send.js").sendMessageSlack>();
const finalizeSlackPreviewEditMock = vi.fn(async (_input: { blocks?: unknown }) => {});
const normalizeSlackOutboundTextMock = vi.fn((value: string) => value.trim());
const postMessageMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const chatUpdateMock = vi.fn(async () => ({ ok: true, ts: "171234.999" }));
const recordSlackThreadParticipationMock = vi.fn();
const updateLastRouteMock = vi.hoisted(() => vi.fn(async () => {}));
const appendSlackStreamMock = vi.fn(async (_input?: unknown) => {});
const startSlackStreamMock = vi.fn(async (_input?: unknown) => createNativeStreamSession());
const stopSlackStreamMock = vi.fn(async (_params?: unknown) => ({}) as { messageId?: string });
const emitSlackMessageSentHooksMock = vi.fn(() => {});
const reactSlackMessageMock = vi.fn(async () => {});
const removeSlackReactionMock = vi.fn(async () => {});
const editSlackMessageMock = vi.fn<typeof import("../../actions.js").editSlackMessage>();
const editSlackRenderedMessageMock =
  vi.fn<typeof import("../../actions.js").editSlackRenderedMessage>();
const deleteSlackMessageMock = vi.fn<typeof import("../../actions.js").deleteSlackMessage>();
const logVerboseMock = vi.fn();
class TestSlackStreamNotDeliveredError extends Error {
  constructor(
    readonly pendingText: string,
    readonly slackCode: string,
  ) {
    super(`slack-stream not delivered: ${slackCode}`);
    this.name = "SlackStreamNotDeliveredError";
  }
}
let mockedNativeStreaming = false;
let mockedSlackStreamingMode: "off" | "partial" | "block" | "progress" = "partial";
let mockedPinnedMainDmOwner: string | undefined;
let capturedReplyOptions: GetReplyOptions | undefined;
let capturedStatusReactionOptions: { enabled?: boolean; initialEmoji?: string } | undefined;
const statusReactionControllerMock = {
  setQueued: vi.fn(async () => {}),
  setThinking: vi.fn(async () => {}),
  setTool: vi.fn(async () => {}),
  setError: vi.fn(async () => {}),
  setDone: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  restoreInitial: vi.fn(async () => {}),
};
let mockedReplyThreadTs: string | undefined = THREAD_TS;
let mockedStatusThreadTs: string | undefined = THREAD_TS;
let mockedReplyThreadTsSequence: Array<string | undefined> | undefined;
let mockedSlackReplyBlocks: unknown[] | undefined;
let mockedSlackIsThreadReply = true;
type TypingCallbacks = {
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError?: (err: unknown) => void;
};
let capturedTyping: TypingCallbacks | undefined;
let mockedDispatchSequence: TestDispatchSequenceEntry[] = [];
let mockedQueuedDispatchCounts: TestDispatchCounts = { tool: 0, block: 0, final: 0 };
let mockedAgentRunTerminalOutcome: "completed" | "failed" | undefined;
let mockedSourceReplyDelivered = false;
let mockedDispatchError: Error | undefined;
let useRealChannelInboundTurn = false;

let mockedReplyOptionEvents: SlackReplyOptionEvent[] = [];

function requireCapturedTyping() {
  if (!capturedTyping) {
    throw new Error("expected Slack typing callback");
  }
  return capturedTyping;
}

function requireCapturedItemEventHandler() {
  const handler = capturedReplyOptions?.onItemEvent;
  if (!handler) {
    throw new Error("expected Slack reply item event handler");
  }
  return handler;
}

function expectNativeProgressStart(chunks: unknown[]) {
  expectNoCalls(postMessageMock, chatUpdateMock);
  expectMockCallArgFields(startSlackStreamMock, 0, {
    channel: "C123",
    threadTs: THREAD_TS,
    taskDisplayMode: "plan",
    chunks,
  });
}

function expectNativeProgressAppend(index: number, chunks: unknown[]) {
  expectMockCallArgFields(appendSlackStreamMock, index, { chunks });
}

function expectNativeStreamText(text: string, count = 1) {
  const matches = [...startSlackStreamMock.mock.calls, ...appendSlackStreamMock.mock.calls].filter(
    (call) => {
      return requireRecord(call[0], "native stream text append").text === text;
    },
  );
  expect(matches).toHaveLength(count);
}

function collectNativeTaskUpdates() {
  return nativeChunks([
    ...startSlackStreamMock.mock.calls,
    ...appendSlackStreamMock.mock.calls,
    ...stopSlackStreamMock.mock.calls,
  ]).filter((chunk) => chunk.type === "task_update");
}

function expectDeliverReplyCall(index: number, text: string, fields?: Record<string, unknown>) {
  const params = mockRecord(deliverRepliesMock, index);
  expectRecordFields(params, { replyThreadTs: THREAD_TS, ...fields });
  expect(params.replies).toEqual([{ text }]);
}

function progressAccount(
  progress: Record<string, unknown> = { toolProgress: true, label: "Working" },
) {
  mockedSlackStreamingMode = "progress";
  return { streaming: { mode: "progress", progress } };
}

function mockRecord(mock: unknown, index = 0) {
  return requireRecord(requireMockCall(mock, index, "call")[0], "params");
}

function expectNativeRotation() {
  expectCalls(2, startSlackStreamMock, stopSlackStreamMock);
  expect(stopSlackStreamMock.mock.invocationCallOrder[0]).toBeLessThan(
    startSlackStreamMock.mock.invocationCallOrder[1] ?? 0,
  );
}

function expectSentHook(index: number, content: string, fields: Record<string, unknown> = {}) {
  expectMockCallArgFields(emitSlackMessageSentHooksMock, index, {
    content,
    success: true,
    ...fields,
  });
}

function delivered(index = 0) {
  return deliverRepliesMock.mock.calls[index]![0];
}

function createNativeStreamSession() {
  return { channel: "C123", threadTs: THREAD_TS, stopped: false, delivered: true, pendingText: "" };
}

function useDraftStream(finalize = false) {
  if (finalize) {
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
  }
  const draftStream = createDraftStreamStub();
  createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
  return draftStream;
}

function draftUpdateTexts(draftStream: ReturnType<typeof createDraftStreamStub>): string[] {
  return draftStream.update.mock.calls.map(([update]) => {
    if (typeof update === "string") {
      return update;
    }
    return requireRecord(update, "draft update").text as string;
  });
}

function expectLastDraftUpdateText(
  draftStream: ReturnType<typeof createDraftStreamStub>,
  expected: string,
) {
  expect(draftUpdateTexts(draftStream).at(-1)).toBe(expected);
}

function createPreparedSlackMessage(params?: {
  cfg?: Record<string, unknown>;
  accountConfig?: Record<string, unknown>;
  ctxPayload?: Record<string, unknown>;
  message?: Partial<PreparedSlackMessage["message"]>;
  replyToMode?: "off" | "first" | "all" | "batched";
  isDirectMessage?: boolean;
  route?: Partial<PreparedSlackMessage["route"]>;
  typingReaction?: string;
  ackReactionMessageTs?: string;
  ackReactionPromise?: Promise<boolean> | null;
  relayIdentity?: { username?: string; iconUrl?: string; iconEmoji?: string };
  turnAdoptionLifecycle?: object;
  dispatchReplyFromConfig?: unknown;
  eventScope?: {
    teamId: string;
    client: Record<string, unknown>;
  };
}) {
  const routeSessionKey = params?.route?.sessionKey ?? "agent:agent-1:slack:C123";
  const mainSessionKey = params?.route?.mainSessionKey ?? "main";
  const lastRoutePolicy =
    params?.route?.lastRoutePolicy ?? (routeSessionKey === mainSessionKey ? "main" : "session");
  const message = {
    channel: "C123",
    ts: "171234.111",
    thread_ts: THREAD_TS,
    user: "U123",
    ...params?.message,
  };

  return {
    ctx: {
      cfg: params?.cfg ?? {},
      runtime: {},
      botToken: "xoxb-test",
      app: { client: { chat: { postMessage: postMessageMock, update: chatUpdateMock } } },
      teamId: "T1",
      botUserId: "U_OPENCLAW",
      botId: "B_OPENCLAW",
      textLimit: 4000,
      typingReaction: params?.typingReaction ?? "",
      historyLimit: 0,
      allowFrom: [],
      dispatchReplyFromConfig: params?.dispatchReplyFromConfig,
      setSlackSessionStatus: async () => true,
    },
    account: {
      accountId: "default",
      config: params?.accountConfig ?? {},
    },
    relayIdentity: params?.relayIdentity,
    turnAdoptionLifecycle: params?.turnAdoptionLifecycle,
    eventScope: params?.eventScope,
    message,
    route: {
      agentId: "agent-1",
      accountId: "default",
      mainSessionKey,
      sessionKey: routeSessionKey,
      lastRoutePolicy,
      ...params?.route,
    },
    channelConfig: null,
    replyTarget: `channel:${message.channel}`,
    ctxPayload: {
      MessageThreadId: THREAD_TS,
      ...params?.ctxPayload,
    },
    turn: {
      record: {},
    },
    replyToMode: params?.replyToMode ?? "all",
    isDirectMessage: params?.isDirectMessage ?? false,
    isRoomish: false,
    ackReactionValue: "eyes",
    ackReactionMessageTs: params?.ackReactionMessageTs,
    ackReactionPromise: params?.ackReactionPromise ?? null,
  } as never;
}

async function dispatch(params?: Parameters<typeof createPreparedSlackMessage>[0]) {
  await dispatchPreparedSlackMessage(createPreparedSlackMessage(params));
}

async function dispatchProgress(progress?: Parameters<typeof progressAccount>[0]) {
  await dispatch({ accountConfig: progressAccount(progress) });
}

async function dispatchWithReactions() {
  await dispatch({
    cfg: { messages: { statusReactions: { enabled: true } } },
    ackReactionMessageTs: "171234.111",
    ackReactionPromise: Promise.resolve(true),
  });
}

function recordNativeSessions() {
  const sessions: ReturnType<typeof createNativeStreamSession>[] = [];
  startSlackStreamMock.mockImplementation(async () => {
    const session = createNativeStreamSession();
    sessions.push(session);
    return session;
  });
  return sessions;
}

async function humanReplyCheckpoint() {
  const { noteSlackDraftConversationMessage } = await import("../../draft-message-boundaries.js");
  return checkpoint(async () => {
    expect(startSlackStreamMock).toHaveBeenCalledOnce();
    noteSlackDraftConversationMessage(HUMAN_THREAD_REPLY);
  });
}

async function dispatchNativeProgressScenario(params: {
  events: typeof mockedReplyOptionEvents;
  cfg?: Record<string, unknown>;
  finalPayload?: TestReplyPayload;
  progress?: {
    style?: "card" | "compact";
    label?: string | false;
    maxLineChars?: number;
    nativeTaskCards?: true;
    render?: "rich";
    toolProgress?: boolean;
    commandText?: "raw" | "status";
  };
  replyToMode?: "off" | "first" | "all" | "batched";
  eventScope?: {
    teamId: string;
    client: Record<string, unknown>;
  };
}) {
  mockedNativeStreaming = true;
  mockedSlackStreamingMode = "progress";
  mockedDispatchSequence =
    params.finalPayload === undefined ? [] : [{ kind: "final", payload: params.finalPayload }];
  mockedReplyOptionEvents = params.events;

  await dispatch({
    cfg: params.cfg,
    replyToMode: params.replyToMode,
    eventScope: params.eventScope,
    accountConfig: progressAccount({
      toolProgress: true,
      ...(params.progress ?? { nativeTaskCards: true }),
    }),
  });
}

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-feedback", () => ({
  createStatusReactionController: (params: { enabled?: boolean; initialEmoji?: string }) => {
    capturedStatusReactionOptions = params;
    return statusReactionControllerMock;
  },
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
        // Gate timing lives in the compositor suite; dispatch tests exercise
        // Slack rendering and delivery after work admits the draft.
        setTimeoutFn: ((handler: () => void) => {
          handler();
          return 0 as never;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => {}) as typeof clearTimeout,
      }),
    createChannelMessageReplyPipeline: (params: {
      transformReplyPayload?: (payload: TestReplyPayload) => TestReplyPayload | null;
      typing?: TypingCallbacks;
    }) => {
      capturedTyping = params.typing;
      return {
        ...(params.typing
          ? {
              typingCallbacks: {
                onReplyStart: params.typing.start,
                onIdle: () => {
                  void params.typing?.stop?.();
                },
              },
            }
          : {}),
        ...(params.transformReplyPayload
          ? { transformReplyPayload: params.transformReplyPayload }
          : {}),
        onModelSelected: undefined,
      };
    },
    resolveChannelMessageSourceReplyDeliveryMode:
      actual.resolveChannelMessageSourceReplyDeliveryMode,
    resolveAgentOutboundIdentity: () => undefined,
    buildChannelProgressDraftLine: ({ explanation }: { explanation?: string }) =>
      explanation
        ? {
            kind: "plan",
            text: `🗺️ Update Plan: ${explanation}`,
            label: "Update Plan",
            detail: explanation,
            toolName: "update_plan",
          }
        : undefined,
    resolveChannelProgressDraftMaxLineChars: (entry?: {
      streaming?: { progress?: { maxLineChars?: number } };
    }) => entry?.streaming?.progress?.maxLineChars,
    resolveChannelStreamingBlockEnabled: () => false,
  };
});

vi.mock("openclaw/plugin-sdk/reply-payload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-payload")>()),
  resolveAskUserQuestionOptionIndices: () => undefined,
  isReplyPayloadNonTerminalToolErrorWarning: () => false,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  danger: (message: string) => message,
  logVerbose: logVerboseMock,
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>();
  return { ...actual, getGlobalHookRunner: getGlobalHookRunnerMock };
});

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => mockedPinnedMainDmOwner,
}));

vi.mock("../../actions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions.js")>()),
  reactSlackMessage: reactSlackMessageMock,
  removeSlackReaction: removeSlackReactionMock,
  editSlackMessage: editSlackMessageMock,
  editSlackRenderedMessage: editSlackRenderedMessageMock,
  deleteSlackMessage: deleteSlackMessageMock,
}));

// mock-isolation: Keep draft transport effects inside the per-test stream fixtures.
vi.mock("../../draft-stream.js", () => ({ createSlackDraftStream: createSlackDraftStreamMock }));

vi.mock("../../format.js", () => ({
  markdownToSlackMrkdwnChunks: (value: string) => [value],
  normalizeSlackOutboundText: normalizeSlackOutboundTextMock,
}));

// mock-isolation: Fixed limits keep split and rotation scenarios independent of runtime config.
vi.mock("../../limits.js", () => ({ SLACK_TEXT_LIMIT: 4000, SLACK_EDIT_TEXT_MAX_BYTES: 4000 }));

vi.mock("../../sent-thread-cache.js", () => ({
  clearSlackThreadFailureNotice: () => {},
  hasSlackThreadParticipation: () => false,
  recordSlackThreadFailureNotice: () => true,
  recordSlackThreadParticipation: recordSlackThreadParticipationMock,
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    changed: true,
    rendered: incoming,
    source: incoming,
  }),
  resolveSlackStreamingConfig: () => ({
    mode: mockedSlackStreamingMode,
    nativeStreaming: mockedNativeStreaming,
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: appendSlackStreamMock,
  markSlackStreamFallbackDelivered: (session: {
    delivered: boolean;
    pendingText: string;
    stopped: boolean;
  }) => {
    session.pendingText = "";
    session.stopped = !session.delivered;
  },
  SlackStreamNotDeliveredError: TestSlackStreamNotDeliveredError,
  startSlackStream: async (input: unknown) =>
    Object.assign(await startSlackStreamMock(input), { streamer: { ts: STREAM_MESSAGE_TS } }),
  stopSlackStream: async (params: { session: { stopped: boolean } }) => {
    params.session.stopped = true;
    return await stopSlackStreamMock(params);
  },
}));

vi.mock("../../message-sent-hook.js", () => ({
  emitSlackMessageSentHooks: emitSlackMessageSentHooksMock,
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadContext: () => ({
    messageThreadId: mockedStatusThreadTs,
    isThreadReply: mockedSlackIsThreadReply,
  }),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: (value: string) => value,
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>()),
  resolveStorePath: () => "/tmp/openclaw-store.json",
  updateLastRoute: updateLastRouteMock,
}));

vi.mock("../../reply-blocks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../reply-blocks.js")>()),
  resolveSlackReplyBlocks: () => mockedSlackReplyBlocks,
}));

vi.mock("../replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../replies.js")>()),
  createSlackReplyDeliveryPlan: () => ({
    peekThreadTs: () =>
      mockedReplyThreadTsSequence ? mockedReplyThreadTsSequence[0] : mockedReplyThreadTs,
    nextThreadTs: () =>
      mockedReplyThreadTsSequence ? mockedReplyThreadTsSequence.shift() : mockedReplyThreadTs,
    markSent: () => {},
  }),
  deliverReplies: (params: Parameters<typeof import("../replies.js").deliverReplies>[0]) =>
    deliverRepliesMock({ ...params, replies: params.replies.map((prepared) => prepared.payload) }),
}));

vi.mock("../../send.js", () => ({ sendMessageSlack: sendMessageSlackMock }));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type DispatchParams = Parameters<typeof actual.dispatchChannelInboundTurn>[0];
  return {
    ...actual,
    readAgentRunTerminalOutcome: () => mockedAgentRunTerminalOutcome,
    dispatchChannelInboundTurn: async (params: DispatchParams) => {
      if (useRealChannelInboundTurn) {
        return actual.dispatchChannelInboundTurn(params);
      }
      capturedReplyOptions = params.replyOptions as typeof capturedReplyOptions;
      for (const [index, entry] of mockedReplyOptionEvents.entries()) {
        if (entry.kind === "item") {
          const { kind: _kind, itemKind, ...payload } = entry;
          await params.replyOptions?.onItemEvent?.({ ...payload, kind: itemKind });
        } else if (entry.kind === "command_output") {
          const { kind: _kind, explanation: _explanation, ...payload } = entry;
          await params.replyOptions?.onCommandOutput?.(payload);
          if (entry.phase === "end") {
            const item = projectAgentToolActivity({
              toolCallId: entry.toolCallId ?? entry.itemId ?? `tool-${index}`,
              name: entry.name ?? "exec",
              phase: "result",
              isError: entry.exitCode == null ? undefined : entry.exitCode !== 0,
              meta: entry.title,
            });
            await params.replyOptions?.onItemEvent?.({
              ...item,
              itemId: entry.itemId ?? item.itemId,
            });
          }
        } else if (entry.kind === "tool_start") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onToolStart?.(payload);
          const item = projectAgentToolActivity({
            toolCallId: entry.toolCallId ?? entry.itemId ?? `tool-${index}`,
            name: entry.name,
            phase: entry.phase === "update" ? "update" : "start",
            args: entry.args,
          });
          await params.replyOptions?.onItemEvent?.({
            ...item,
            itemId: entry.itemId ?? item.itemId,
          });
        } else if (entry.kind === "patch") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onPatchSummary?.(payload);
          if (entry.phase === "end") {
            await params.replyOptions?.onItemEvent?.({
              itemId: entry.itemId,
              toolCallId: entry.toolCallId,
              kind: "patch",
              phase: "end",
              status: "completed",
              title: entry.title ?? "Apply Patch",
              name: entry.name,
              meta: entry.summary,
            });
          }
        } else if (entry.kind === "plan") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onPlanUpdate?.(payload);
        } else if (entry.kind === "concurrent_items") {
          await Promise.all(
            entry.progressTexts.map((progressText) =>
              Promise.resolve(params.replyOptions?.onItemEvent?.({ progressText })),
            ),
          );
        } else if (entry.kind === "assistant_start") {
          await params.replyOptions?.onAssistantMessageStart?.();
        } else if (entry.kind === "reasoning") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onReasoningStream?.(payload);
        } else if (entry.kind === "reasoning_end") {
          await params.replyOptions?.onReasoningEnd?.();
        } else if (entry.kind === "visible_work") {
          await params.replyOptions?.onVisibleWorkSessions?.(entry.sessions);
        } else if (entry.kind === "checkpoint") {
          await entry.run();
        } else if (entry.kind === "approval") {
          const { kind: _kind, ...payload } = entry;
          await params.replyOptions?.onApprovalEvent?.(payload);
        } else {
          await params.replyOptions?.onPartialReply?.({ text: entry.text });
        }
      }
      if (mockedDispatchError) {
        throw mockedDispatchError;
      }
      for (const entry of mockedDispatchSequence) {
        if (entry.kind === "checkpoint") {
          await entry.run();
          continue;
        }
        if (entry.kind === "queued_followup") {
          await params.replyOptions?.onQueuedFollowupAdmitted?.();
          continue;
        }
        if (entry.kind === "item") {
          await params.replyOptions?.onItemEvent?.({ progressText: entry.progressText });
          continue;
        }
        const payload = entry.payload as ReplyPayload;
        const transformed = params.dispatcherOptions?.transformReplyPayload
          ? params.dispatcherOptions.transformReplyPayload(payload)
          : payload;
        if (!transformed) {
          continue;
        }
        const deliverPayload = params.dispatcherOptions?.beforeDeliver
          ? await params.dispatcherOptions.beforeDeliver(transformed, { kind: entry.kind })
          : transformed;
        if (!deliverPayload) {
          continue;
        }
        mockedQueuedDispatchCounts[entry.kind] += 1;
        const dispatcher = createReplyDispatcher({
          deliver: params.delivery.deliver,
          onError: params.delivery.onError,
        });
        if (entry.kind === "tool") {
          dispatcher.sendToolResult(deliverPayload);
        } else if (entry.kind === "block") {
          dispatcher.sendBlockReply(deliverPayload);
        } else {
          dispatcher.sendFinalReply(deliverPayload);
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }
      return {
        admission: { kind: "dispatch" } as const,
        dispatched: true as const,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { ...mockedQueuedDispatchCounts },
          observedReplyDelivery: mockedSourceReplyDelivered,
        },
      };
    },
  };
});

vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: finalizeSlackPreviewEditMock,
}));

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;

beforeAll(async () => {
  ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
});

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackSetupPlugin }]),
  );
  createSlackDraftStreamMock.mockReset();
  deliverRepliesMock.mockReset();
  sendMessageSlackMock.mockReset();
  editSlackMessageMock.mockReset();
  editSlackRenderedMessageMock.mockReset();
  deleteSlackMessageMock.mockReset();
  useRealChannelInboundTurn = false;
  finalizeSlackPreviewEditMock.mockReset();
  normalizeSlackOutboundTextMock.mockClear();
  postMessageMock.mockClear();
  chatUpdateMock.mockClear();
  recordSlackThreadParticipationMock.mockReset();
  updateLastRouteMock.mockReset();
  appendSlackStreamMock.mockReset();
  startSlackStreamMock.mockReset();
  stopSlackStreamMock.mockReset();
  reactSlackMessageMock.mockReset();
  removeSlackReactionMock.mockReset();
  logVerboseMock.mockReset();
  getGlobalHookRunnerMock.mockReset().mockReturnValue(undefined);
  for (const value of Object.values(statusReactionControllerMock)) {
    value.mockClear();
  }
  mockedNativeStreaming = false;
  mockedSlackStreamingMode = "partial";
  mockedPinnedMainDmOwner = undefined;
  capturedReplyOptions = undefined;
  capturedStatusReactionOptions = undefined;
  capturedTyping = undefined;
  mockedReplyThreadTs = THREAD_TS;
  mockedStatusThreadTs = THREAD_TS;
  mockedReplyThreadTsSequence = undefined;
  mockedSlackReplyBlocks = undefined;
  mockedSlackIsThreadReply = true;
  mockedDispatchSequence = [textReply(FINAL_REPLY_TEXT)];
  mockedQueuedDispatchCounts = { tool: 0, block: 0, final: 0 };
  mockedAgentRunTerminalOutcome = undefined;
  mockedSourceReplyDelivered = false;
  mockedDispatchError = undefined;
  mockedReplyOptionEvents = [];

  createSlackDraftStreamMock.mockReturnValue(createDraftStreamStub());
  finalizeSlackPreviewEditMock.mockRejectedValue(new Error("socket closed"));
  startSlackStreamMock.mockResolvedValue(createNativeStreamSession());
  appendSlackStreamMock.mockResolvedValue(undefined);
  stopSlackStreamMock.mockResolvedValue({});
  emitSlackMessageSentHooksMock.mockClear();
});

afterEach(() => resetPluginRuntimeStateForTest());

it.each([false, true])(
  "delivers an explicit final reply target separately from the preview (native: %s)",
  async (native) => {
    mockedNativeStreaming = native;
    const draft = useDraftStream();
    finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
    deliverRepliesMock.mockResolvedValue(normalDeliveryResult);
    mockedReplyOptionEvents = [{ kind: "partial", text: "Working on the answer" }];
    mockedDispatchSequence = [
      { kind: "final", payload: { text: FINAL_REPLY_TEXT, replyToId: "171234.222" } },
    ];
    if (native) {
      mockedDispatchSequence.unshift({
        kind: "block",
        payload: { text: "Working on the answer" },
      });
    }

    await dispatch();

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledOnce();
    expect(delivered().replies[0]).toMatchObject({ replyToId: "171234.222" });
    if (!native) {
      expect(draft.clear).toHaveBeenCalled();
      expect(draft.clear.mock.invocationCallOrder[0]).toBeGreaterThan(
        deliverRepliesMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    }
  },
);

it.each(["all", "off"] as const)(
  "resolves the explicit target before starting a native stream (replyToMode: %s)",
  async (replyToMode) => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: FINAL_REPLY_TEXT, replyToId: "171234.222" } },
    ];

    await dispatch({ replyToMode });

    expectMockCallArgFields(startSlackStreamMock, 0, {
      threadTs: replyToMode === "off" ? THREAD_TS : "171234.222",
      text: FINAL_REPLY_TEXT,
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  },
);

it("finalizes Block Kit work links with bounded labels and numbered fallbacks", async () => {
  const draftStream = useDraftStream(true);
  mockedReplyOptionEvents = [
    {
      kind: "item",
      itemKind: "tool",
      itemId: "work",
      name: "exec",
      phase: "start",
      progressText: "Reviewing changes",
    },
    {
      kind: "visible_work",
      sessions: Array.from({ length: 6 }, (_, i) =>
        workSession(i + 1, i ? undefined : "🚀".repeat(40)),
      ),
    },
  ];
  await dispatch({
    cfg: PROGRESS_LINK_CONFIG,
    accountConfig: progressAccount({
      style: "card",
      toolProgress: true,
      nativeTaskCards: false,
      label: "Shelling",
    }),
  });
  expect(draftStream.update).toHaveBeenCalled();
  expect(JSON.stringify(draftStream.update.mock.calls)).not.toContain('"url":');
  expect(finalizeSlackPreviewEditMock).toHaveBeenCalledOnce();
  const finalEdit = mockRecord(finalizeSlackPreviewEditMock);
  expectRecordFields(finalEdit, { channelId: "C123", messageId: STREAM_MESSAGE_TS });
  if (!Array.isArray(finalEdit.blocks)) {
    throw new Error("expected final work-link blocks");
  }
  const blocks = finalEdit.blocks.map((block) => requireRecord(block, "work-link block"));
  expect(blocks[0]).toEqual(section("Shelling", true));
  expect(blocks).not.toContainEqual(section("Failed", true));
  const actions = blocks.filter((block) => block.type === "actions");
  expect(actions).toHaveLength(1);
  expect(actions[0]?.elements).toEqual(
    [`Open ${"🚀".repeat(34)}…`, ...[2, 3, 4, 5].map((n) => `Open work session ${n}`)].map(
      (text, i) => ({
        type: "button",
        action_id: `openclaw:session_link${i ? `:${i}` : ""}`,
        url: workSession(i + 1).url,
        text: { type: "plain_text", text },
      }),
    ),
  );
  expect(deliverRepliesMock).toHaveBeenCalledOnce();
  expect(delivered().replies).toEqual([{ text: FINAL_REPLY_TEXT }]);
  expectNoCalls(draftStream.clear, startSlackStreamMock);
});

it("completes native sources with one visible work session before final text", async () => {
  const session = workSession(1, "Review");
  await dispatchNativeProgressScenario({
    cfg: PROGRESS_LINK_CONFIG,
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { style: "card", toolProgress: true, nativeTaskCards: true, label: "Shelling" },
    events: [
      {
        kind: "item",
        itemKind: "tool",
        itemId: "work",
        name: "exec",
        phase: "start",
        progressText: "Reviewing changes",
      },
      { kind: "visible_work", sessions: [session] },
      { kind: "visible_work", sessions: [session] },
    ],
  });
  const initial = nativeChunks(startSlackStreamMock.mock.calls);
  expect(initial).toContainEqual(
    expect.objectContaining({ type: "task_update", status: "in_progress" }),
  );
  expect(initial.every((chunk) => !chunk.sources)).toBe(true);
  const completion = nativeChunks([
    ...appendSlackStreamMock.mock.calls,
    ...stopSlackStreamMock.mock.calls,
  ]);
  const linked = completion.filter((chunk) => chunk.sources);
  expect(linked).toHaveLength(1);
  expect(linked[0]).toMatchObject({
    type: "task_update",
    status: "complete",
    sources: [{ type: "url_source", url: session.url, text: "Open work session" }],
  });
  const sourceCall = appendSlackStreamMock.mock.calls.findIndex(([input]) =>
    nativeChunks([[input]]).some((chunk) => chunk.sources),
  );
  const finalCall = appendSlackStreamMock.mock.calls.findIndex(
    ([input]) => requireRecord(input, "native final").text === `\n${FINAL_REPLY_TEXT}`,
  );
  expect(sourceCall).toBeGreaterThanOrEqual(0);
  expect(finalCall).toBeGreaterThan(sourceCall);
  expect(stopSlackStreamMock).toHaveBeenCalledOnce();
  expectNoCalls(deliverRepliesMock, createSlackDraftStreamMock);
});
it.each([
  { agents: ["alice", "bob"], withMedia: true },
  { agents: ["alice", "bob"], withMedia: false },
])(
  "binds group-thread completion hooks and media to the participant: $agents (media: $withMedia)",
  async ({ agents, withMedia }) => {
    useRealChannelInboundTurn = true;
    mockedNativeStreaming = true;
    const { resolveGroupThreadMentionFacts } = await import("openclaw/plugin-sdk/channel-inbound");
    const workspaceRoot = realpathSync(tmpdir());
    const cfg = {
      agents: {
        entries: Object.fromEntries(
          ["root", "alice", "bob"].map((id) => [id, { workspace: path.join(workspaceRoot, id) }]),
        ),
      },
      broadcast: { "slack:C123": agents },
    };
    const rootSessionKey = `agent:root:slack:channel:c123:thread:${THREAD_TS}`;
    const actualReplies = await vi.importActual<typeof import("../replies.js")>("../replies.js");
    const { prepareSlackReply } = await import("../../reply-blocks.js");
    deliverRepliesMock.mockImplementation(async (params) =>
      actualReplies.deliverReplies({
        ...params,
        replies: params.replies.map((reply) => prepareSlackReply(reply)),
      }),
    );
    sendMessageSlackMock.mockResolvedValue({
      messageId: "sent-1",
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", messageId: "sent-1", channelId: "C123" }],
        kind: withMedia ? "media" : "text",
      }),
    });
    const participantRuns: string[] = [];
    const dispatchReplyFromConfig: NonNullable<
      Parameters<typeof dispatchPreparedSlackMessage>[0]["ctx"]["dispatchReplyFromConfig"]
    > = async ({ ctx, dispatcher }) => {
      if (!ctx.AgentId) {
        throw new Error("Expected participant agent identity");
      }
      participantRuns.push(ctx.AgentId);
      return {
        queuedFinal: dispatcher.sendFinalReply({
          text: `Reply from ${ctx.AgentId}`,
          ...(withMedia
            ? { mediaUrl: path.join(workspaceRoot, ctx.AgentId, "attachment.txt") }
            : {}),
        }),
        counts: dispatcher.getQueuedCounts(),
      };
    };

    await dispatch({
      cfg,
      route: { agentId: "root", sessionKey: rootSessionKey },
      ctxPayload: finalizeInboundContext({
        AgentId: "root",
        SessionKey: rootSessionKey,
        ChatType: "channel",
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        NativeChannelId: "C123",
        AccountId: "default",
        From: "slack:C123",
        To: "channel:C123",
        SenderId: "U123",
        MessageSid: "171234.111",
        MessageThreadId: THREAD_TS,
        Body: "Review the attachment.",
        GroupThread: resolveGroupThreadMentionFacts({
          cfg,
          channel: "slack",
          peerId: "C123",
          text: "Review the attachment.",
          sessionKey: rootSessionKey,
        }),
      }),
      dispatchReplyFromConfig,
    });

    expect(participantRuns.toSorted()).toEqual(agents.toSorted());
    expectCalls(agents.length, emitSlackMessageSentHooksMock, sendMessageSlackMock);
    for (const agentId of agents) {
      expect(emitSlackMessageSentHooksMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKeyForInternalHooks: `agent:${agentId}:slack:channel:c123:thread:${THREAD_TS}`,
          success: true,
        }),
      );
      expect(sendMessageSlackMock).toHaveBeenCalledWith(
        "channel:C123",
        expect.stringContaining(`Reply from ${agentId}`),
        expect.objectContaining({
          ...(withMedia ? { mediaUrl: path.join(workspaceRoot, agentId, "attachment.txt") } : {}),
          mediaLocalRoots: expect.arrayContaining([path.join(workspaceRoot, agentId)]),
        }),
      );
    }
    expectNoCalls(startSlackStreamMock, createSlackDraftStreamMock);
  },
);

it.each(["native literal", "split table"] as const)(
  "delivers %s finals through the normal sender instead of a preview edit",
  async (scenario) => {
    const literal = scenario === "native literal";
    mockedNativeStreaming = scenario === "native literal";
    if (literal) {
      finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
    }
    const payload = literal
      ? {
          ...presentation("Run /inspect *literal* <!channel>, then check the report.", [
            {
              type: "buttons",
              buttons: [{ label: "Inspect", action: { type: "command", command: "/inspect" } }],
            },
          ]),
          presentationTextMode: "fallback" as const,
        }
      : presentation("Accounts", [
          {
            type: "table",
            caption: "Account owners",
            headers: ["Owner"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `owner-${String(index)}-${"x".repeat(110)}`,
            ]),
          },
          { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
        ]);
    mockedDispatchSequence = [finalReply(payload)];
    await dispatch();
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(delivered().replies).toEqual([payload]);
    if (literal) {
      expectNoCalls(startSlackStreamMock, appendSlackStreamMock);
    }
  },
);

it("preserves rejected queue admission without retaining a publisher", async () => {
  const onSettled = vi.fn();
  const prepared: Parameters<typeof dispatchPreparedSlackMessage>[0] = createPreparedSlackMessage({
    turnAdoptionLifecycle: {
      admission: "exclusive",
      onAdopted: async () => {},
      onDeferred: () => false,
      onSettled,
    },
  });
  await dispatchPreparedSlackMessage(prepared);
  expect(capturedReplyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(false);
  expect(getSlackSessionRuns(prepared.ctx, { channelId: "C123", threadTs: THREAD_TS })).toEqual([]);
  await capturedReplyOptions?.turnAdoptionLifecycle?.onSettled?.();
  expect(onSettled).toHaveBeenCalledOnce();
});

it("tracks a first-mode root publisher without a status thread", async () => {
  const message = {
    type: "message" as const,
    channel: "C123",
    ts: "171234.111",
    thread_ts: undefined,
  };
  const threading =
    await vi.importActual<typeof import("../../threading.js")>("../../threading.js");
  mockedStatusThreadTs = threading.resolveSlackThreadContext({
    message,
    replyToMode: "first",
  }).messageThreadId;
  expect(mockedStatusThreadTs).toBeUndefined();
  mockedReplyThreadTs = message.ts;
  mockedSlackIsThreadReply = false;
  const prepared: Parameters<typeof dispatchPreparedSlackMessage>[0] = createPreparedSlackMessage({
    message,
    replyToMode: "first",
  });
  mockedReplyOptionEvents = [
    checkpoint(async () => {
      expect(
        getSlackSessionRuns(prepared.ctx, { channelId: message.channel, threadTs: message.ts }).map(
          ({ route }) => route.sessionKey,
        ),
      ).toEqual([prepared.route.sessionKey]);
    }),
  ];
  await dispatchPreparedSlackMessage(prepared);
});

it.each([false, true])(
  "retains queued publisher ownership until settlement (executed: %s)",
  async (executed) => {
    const prepared: Parameters<typeof dispatchPreparedSlackMessage>[0] = createPreparedSlackMessage(
      {
        turnAdoptionLifecycle: {
          admission: "exclusive",
          onAdopted: async () => {},
          onDeferred: () => {},
          onAbandoned: () => {},
        },
      },
    );
    const address = { channelId: "C123", threadTs: THREAD_TS };
    mockedReplyOptionEvents = [
      checkpoint(async () => {
        expect(
          getSlackSessionRuns(prepared.ctx, address).map(({ route }) => route.sessionKey),
        ).toEqual([prepared.route.sessionKey]);
        capturedReplyOptions?.turnAdoptionLifecycle?.onDeferred?.();
      }),
    ];
    await dispatchPreparedSlackMessage(prepared);
    expect(getSlackSessionRuns(prepared.ctx, address).map(({ route }) => route.sessionKey)).toEqual(
      [prepared.route.sessionKey],
    );
    const endQueuedRun = executed
      ? capturedReplyOptions?.queuedDeliveryCorrelations?.[0]?.begin()
      : undefined;
    await capturedReplyOptions?.turnAdoptionLifecycle?.onSettled?.();
    expect(getSlackSessionRuns(prepared.ctx, address)).toHaveLength(executed ? 1 : 0);
    expect(getSlackSessionRuns({ ...prepared.ctx }, address)).toHaveLength(executed ? 1 : 0);
    const restarted: Parameters<typeof dispatchPreparedSlackMessage>[0] =
      createPreparedSlackMessage();
    expect(getSlackSessionRuns(restarted.ctx, address)).toEqual([]);
    endQueuedRun?.();
    expect(getSlackSessionRuns(prepared.ctx, address)).toEqual([]);
  },
);

it("gates native progress previews before message_sending hooks", async () => {
  getGlobalHookRunnerMock.mockReturnValue({
    hasHooks: vi.fn((name: string) => name === "message_sending"),
  });
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    events: [{ kind: "item", progressText: "private progress" }],
  });
  expectNoCalls(
    createSlackDraftStreamMock,
    finalizeSlackPreviewEditMock,
    startSlackStreamMock,
    appendSlackStreamMock,
  );
  expect(deliverRepliesMock).toHaveBeenCalledOnce();
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
});

it("posts the final below a human message received while the preview was sealing", async () => {
  let messageId: string | undefined = "171234.567";
  const draftStream = {
    ...createDraftStreamStub(),
    seal: vi.fn(async () => {
      messageId = undefined;
    }),
    finalizeMessage: vi.fn(async () => false),
    messageId: () => messageId,
    channelId: () => (messageId ? "C123" : undefined),
  };
  createSlackDraftStreamMock.mockReturnValueOnce(draftStream);

  await dispatch();

  expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
  expect(deliverRepliesMock).toHaveBeenCalledOnce();
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
});

it.each([false, true])("preserves custom authorship with native streaming %s", async (native) => {
  mockedNativeStreaming = native;
  const relayIdentity = {
    username: "Nik Team Claw",
    ...(native ? {} : { iconEmoji: ":robot_face:" }),
  };
  const draftStream = useDraftStream();
  await dispatch({ relayIdentity });
  if (native) {
    expectMockCallArgFields(startSlackStreamMock, 0, {
      text: FINAL_REPLY_TEXT,
      identity: relayIdentity,
    });
    expectNoCalls(createSlackDraftStreamMock, deliverRepliesMock);
  } else {
    expect(createSlackDraftStreamMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ identity: expect.anything() }),
    );
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { identity: relayIdentity });
  }
});

it("does not create a Slack thread for top-level messages when replyToMode is off", async () => {
  mockedSlackStreamingMode = "off";
  mockedSlackIsThreadReply = false;

  await dispatch({ replyToMode: "off" });

  expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { replyThreadTs: undefined });
});

it.each([
  { name: "non-main direct session", transport: false },
  { name: "transport thread", transport: true },
])("records DM last-route metadata for $name", async ({ transport }) => {
  const sessionKey = transport ? "agent:main:main" : "agent:main:slack:direct:u1";
  const threadId = transport ? "701.000" : "500.000";
  const ctxPayload = transport
    ? {
        MessageThreadId: undefined,
        ReplyToId: threadId,
        TransportThreadId: threadId,
        SessionKey: sessionKey,
      }
    : { MessageThreadId: threadId, SessionKey: sessionKey };
  mockedPinnedMainDmOwner = transport ? undefined : "U2";
  await dispatch({
    ...(!transport ? { cfg: { session: { dmScope: "per-channel-peer" } } } : {}),
    isDirectMessage: true,
    message: {
      channel: "D123",
      user: "U1",
      ts: transport ? threadId : "501.000",
      thread_ts: threadId,
    },
    route: {
      agentId: "main",
      mainSessionKey: "agent:main:main",
      sessionKey,
      lastRoutePolicy: transport ? "main" : "session",
    },
    ctxPayload,
  });
  expect(updateLastRouteMock).toHaveBeenCalledWith({
    storePath: "/tmp/openclaw-store.json",
    sessionKey,
    deliveryContext: { channel: "slack", to: "user:U1", accountId: "default", threadId },
    ctx: ctxPayload,
  });
});

it.each([
  ["code", "```\n| Name | Value |\n| ---- | ----- |\n| Beta | 2     |\n```"],
  ["bullets", "*Beta*\n• Value: 2"],
] as const)(
  "preserves %s table mode when finalizing authored preview text",
  async (tables, expected) => {
    const { normalizeSlackOutboundText } =
      await vi.importActual<typeof import("../../format.js")>("../../format.js");
    normalizeSlackOutboundTextMock.mockImplementation(normalizeSlackOutboundText);
    try {
      finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
      mockedDispatchSequence = [textReply("| Name | Value |\n| --- | --- |\n| Beta | 2 |")];

      await dispatch({ cfg: { channels: { slack: { markdown: { tables } } } } });

      expect(finalizeSlackPreviewEditMock).toHaveBeenCalledOnce();
      expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, {
        channelId: "C123",
        messageId: "171234.567",
        text: expected,
      });
      expect(deliverRepliesMock).not.toHaveBeenCalled();
    } finally {
      normalizeSlackOutboundTextMock.mockImplementation((value: string) => value.trim());
    }
  },
);

it.each([
  {
    operation: "add",
    error: "missing_scope",
    details: { needed: "reactions:write", provided: "chat:write" },
    suffix: "; needed: reactions:write; provided: chat:write",
  },
  { operation: "remove", error: "invalid_auth", details: undefined, suffix: "" },
])(
  "logs the formatted Slack error when typing reaction $operation fails",
  async ({ operation, error, details, suffix }) => {
    (operation === "add" ? reactSlackMessageMock : removeSlackReactionMock).mockRejectedValueOnce(
      createSlackPlatformError(error, details),
    );
    await dispatch({ typingReaction: "hourglass_flowing_sand" });
    const typing = requireCapturedTyping();
    await expect(typing.start()).resolves.toBeUndefined();
    if (operation === "remove") {
      await expect(typing.stop?.()).resolves.toBeUndefined();
    }
    expect(logVerboseMock).toHaveBeenCalledWith(
      `slack send: typing reaction${operation === "remove" ? " removal" : ""} failed: An API error occurred: ${error}; code: slack_webapi_platform_error; slack error: ${error}${suffix}`,
    );
  },
);

it.each(["message-tool-only", "recovered-failure", "room-event", "reasoning-only"] as const)(
  "settles lifecycle reactions for %s delivery",
  async (scenario) => {
    const failed = scenario === "recovered-failure";
    const toolOnly = scenario === "message-tool-only";
    const ambient = scenario === "room-event";
    if (failed) {
      mockedAgentRunTerminalOutcome = "failed";
      mockedNativeStreaming = true;
      mockedReplyOptionEvents = [{ kind: "item", progressText: "Recovering failed run" }];
      mockedDispatchSequence = [finalReply({ text: "Something failed", isError: true })];
    } else if (scenario === "reasoning-only") {
      mockedDispatchSequence = [finalReply({ text: "Reasoning:\n_hidden_", isReasoning: true })];
    }
    await dispatch({
      cfg: {
        messages: {
          ...(toolOnly ? { groupChat: { visibleReplies: "message_tool" } } : {}),
          statusReactions: { enabled: true },
        },
      },
      ...(failed
        ? { accountConfig: progressAccount({ toolProgress: true, nativeTaskCards: true }) }
        : {}),
      ...(toolOnly || ambient
        ? {
            ctxPayload: {
              ChatType: "channel",
              ...(ambient ? { InboundEventKind: "room_event" } : {}),
            },
          }
        : {}),
      ackReactionMessageTs: "171234.111",
      ackReactionPromise: Promise.resolve(true),
    });
    if (toolOnly || ambient) {
      expectRecordFields(requireRecord(capturedStatusReactionOptions, "status reaction options"), {
        enabled: !ambient,
        initialEmoji: "eyes",
      });
      expect(statusReactionControllerMock.setQueued).toHaveBeenCalledTimes(ambient ? 0 : 1);
    }
    if (toolOnly) {
      expect(capturedReplyOptions).toMatchObject({
        disableBlockStreaming: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        allowToolLifecycleWhenProgressHidden: true,
      });
    }
    expect(statusReactionControllerMock.setDone).toHaveBeenCalledTimes(toolOnly ? 1 : 0);
    if (!ambient) {
      expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
    }
    if (toolOnly || failed) {
      const terminal = failed
        ? statusReactionControllerMock.setError
        : statusReactionControllerMock.setDone;
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal.mock.invocationCallOrder[0]).toBeLessThan(
        statusReactionControllerMock.restoreInitial.mock.invocationCallOrder[0] ?? 0,
      );
    }
    if (failed) {
      expectCalls(1, deliverRepliesMock, startSlackStreamMock, stopSlackStreamMock);
      expect(collectNativeTaskUpdates().at(-1)).toEqual(
        expect.objectContaining({ status: "error" }),
      );
    } else if (scenario === "reasoning-only") {
      expect(deliverRepliesMock).not.toHaveBeenCalled();
    }
  },
);

it("finalizes a labeled session card separately from final text", async () => {
  const draftStream = useDraftStream(true);
  mockedSlackStreamingMode = "progress";
  mockedReplyOptionEvents = [
    { kind: "item", progressText: "tool one" },
    { kind: "partial", text: "partial answer" },
    { kind: "item", progressText: "tool two" },
  ];
  await dispatch({
    cfg: {
      gateway: { publicOrigin: "https://team.openclaw.ai", controlUi: { basePath: "/openclaw" } },
    },
    accountConfig: { streaming: { progress: { toolProgress: true, label: "Shelling" } } },
  });
  const title = section("Shelling", true);
  expect(draftStream.update).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: "Shelling\n\n_tool one_\n_tool two_\n\n1s",
      blocks: expect.arrayContaining([title]),
    }),
  );
  expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
  expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, {
    channelId: "C123",
    messageId: "171234.567",
  });
  const finalEdit = mockRecord(finalizeSlackPreviewEditMock, 0);
  expect(finalEdit.blocks).toContainEqual(title);
  expect(JSON.stringify(finalEdit.blocks)).toContain("Open in OpenClaw");
  expect(JSON.stringify(finalEdit.blocks)).toContain(
    "https://team.openclaw.ai/openclaw/chat/agent-1/slack/C123",
  );
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  expect(draftStream.clear).not.toHaveBeenCalled();
  expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
});

it.each(["dispatch", "reply"])("settles a working card after failed %s", async (source) => {
  const draftStream = useDraftStream(true);
  mockedSlackStreamingMode = "progress";
  const payload = { text: "tool failed", isError: true };
  mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];
  mockedDispatchSequence = source === "dispatch" ? [] : [finalReply(payload)];
  if (source === "dispatch") {
    mockedDispatchError = new Error("agent dispatch failed");
  }
  const result = dispatchProgress({ toolProgress: true });
  if (source === "dispatch") {
    await expect(result).rejects.toThrow("agent dispatch failed");
  } else {
    await result;
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectRecordFields(delivered(), { replies: [payload] });
  }
  expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
  const finalEdit = mockRecord(finalizeSlackPreviewEditMock, 0);
  expectRecordFields(finalEdit, {
    text: "Failed\n\n_working_",
    blocks: [section("Failed", true), section("_working_")],
  });
  expect(draftStream.clear).not.toHaveBeenCalled();
});

it("posts and seals a failure card for a quiet failed turn without a reply", async () => {
  const { createSlackDraftStream } =
    await vi.importActual<typeof import("../../draft-stream.js")>("../../draft-stream.js");
  let draftStream: ReturnType<typeof createSlackDraftStream> | undefined;
  const edit = editSlackMessageMock.mockImplementation(noopAsync);
  editSlackRenderedMessageMock.mockImplementation(noopAsync);
  const remove = deleteSlackMessageMock.mockImplementation(noopAsync);
  createSlackDraftStreamMock.mockImplementationOnce(
    (params: Parameters<typeof createSlackDraftStream>[0]) => {
      draftStream = createSlackDraftStream(params);
      return draftStream;
    },
  );
  sendMessageSlackMock.mockResolvedValue(normalDeliveryResult);
  finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
  mockedSlackStreamingMode = "progress";
  mockedAgentRunTerminalOutcome = "failed";
  mockedDispatchSequence = [];
  mockedReplyOptionEvents = [
    toolStart(undefined, { itemId: "tool-1" }),
    checkpoint(async () => {
      await draftStream?.flush();
      expect(sendMessageSlackMock).not.toHaveBeenCalled();
    }),
  ];

  await dispatchProgress({ style: "card" });

  const blocks = [section("Failed", true)];
  expect(sendMessageSlackMock).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    "Failed",
    expect.objectContaining({ blocks }),
  );
  expect(finalizeSlackPreviewEditMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: "Failed", blocks, messageId: "normal-final" }),
  );
  expect(draftStream?.messageId()).toBe("normal-final");
  // Sealed cards ignore late updates and survive dispatch cleanup.
  draftStream?.update("late tool activity");
  await draftStream?.flush();
  expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
  expectNoCalls(edit, editSlackRenderedMessageMock, remove);

  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("keeps a failed no-reply card but deletes a silent successful card", async () => {
  const failedDraft = createDraftStreamStub();
  const silentDraft = createDraftStreamStub();
  createSlackDraftStreamMock.mockReturnValueOnce(failedDraft).mockReturnValueOnce(silentDraft);
  finalizeSlackPreviewEditMock.mockResolvedValue(undefined);

  mockedDispatchSequence = [];
  mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];
  mockedAgentRunTerminalOutcome = "failed";

  await dispatchProgress({ toolProgress: true });
  expect(failedDraft.clear).not.toHaveBeenCalled();
  expect(finalizeSlackPreviewEditMock.mock.calls[0]?.[0]?.blocks).toEqual([
    section("Failed", true),
    section("_working_"),
  ]);

  finalizeSlackPreviewEditMock.mockClear();
  mockedAgentRunTerminalOutcome = "completed";
  await dispatchProgress({ toolProgress: true });
  expect(silentDraft.clear).toHaveBeenCalledTimes(1);
  expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
});

it("batches native milestone updates and prevents pending updates after final delivery", async () => {
  vi.useFakeTimers();
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    events: [
      planEvent("Inspect", "Checking the workspace"),
      planEvent("Intermediate", "Checking the workspace"),
      planEvent("Run tests", "Checking the workspace"),
      checkpoint(async () => {
        expect(startSlackStreamMock).toHaveBeenCalledOnce();
        expect(appendSlackStreamMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(999);
        expect(appendSlackStreamMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expectNativeProgressAppend(0, [taskUpdate("plan_step_1", "Run tests", "in_progress")]);
      }),
      planEvent("Final checks", "Checking the workspace"),
    ],
  });
  expect(collectNativeTaskUpdates()).toEqual([
    taskUpdate("plan_step_1", "Inspect", "in_progress"),
    taskUpdate("plan_step_1", "Run tests", "in_progress"),
    taskUpdate("plan_step_1", "Final checks", "complete"),
  ]);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  const appendCount = appendSlackStreamMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(appendSlackStreamMock).toHaveBeenCalledTimes(appendCount);
  expect(stopSlackStreamMock).toHaveBeenCalledOnce();
});

it("flushes approval attention immediately while ordinary progress is batched", async () => {
  vi.useFakeTimers();
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { style: "card", toolProgress: false, nativeTaskCards: true },
    events: [
      toolStart(),
      approval("run checks"),
      checkpoint(async () => {
        expectNativeProgressAppend(0, [
          taskUpdate(
            expect.stringMatching(/^openclaw-attention-/u),
            "Approval required: run checks; approval requested",
            "pending",
          ),
        ]);
      }),
      { kind: "approval", phase: "resolved", approvalId: "approval-1" },
    ],
  });
  expect(
    collectNativeTaskUpdates().filter(
      (task) => typeof task.id === "string" && task.id.startsWith("openclaw-attention-"),
    ),
  ).toEqual([
    taskUpdate(
      expect.stringMatching(/^openclaw-attention-/u),
      "Approval required: run checks; approval requested",
      "pending",
    ),
    taskUpdate(
      expect.stringMatching(/^openclaw-attention-/u),
      "Approval required: run checks; approval requested",
      "complete",
    ),
  ]);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
});

it("keeps intermediate command failures out of quiet native streams", async () => {
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    progress: { style: "card", toolProgress: false, nativeTaskCards: true },
    events: [
      planEvent("Run checks", "Checking the workspace"),
      { kind: "command_output", phase: "end", name: "Bash", title: "run checks", exitCode: 1 },
      { kind: "command_output", phase: "end", name: "Bash", title: "retry checks", exitCode: 8 },
    ],
  });

  const outgoing = JSON.stringify([
    ...startSlackStreamMock.mock.calls,
    ...appendSlackStreamMock.mock.calls,
    ...stopSlackStreamMock.mock.calls,
  ]);
  expect(outgoing).not.toMatch(/Bash|exit [18]|Recovered:/u);
  expect(collectNativeTaskUpdates()).toEqual([
    taskUpdate("plan_step_1", "Run checks", "in_progress"),
    taskUpdate("plan_step_1", "Run checks", "complete"),
  ]);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
});

it("continues a buffered native progress stream with the final reply", async () => {
  const session = { ...createNativeStreamSession(), delivered: false };
  startSlackStreamMock.mockResolvedValue(session);
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    events: [{ kind: "item", progressText: "slow tool" }],
  });
  expect(deliverRepliesMock).not.toHaveBeenCalled();
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
});

it.each(["stop-delivered", "oversized-fallback"] as const)(
  "settles definitely rejected native text through %s",
  async (outcome) => {
    mockedNativeStreaming = true;
    const nativeStopSucceeds = outcome === "stop-delivered";
    const oversized = outcome === "oversized-fallback";
    const text = oversized ? "x".repeat(8500) : "rejected reply";
    mockedDispatchSequence = [textReply("already visible"), { kind: "final", payload: { text } }];
    const session = createNativeStreamSession();
    const rejection = new TestSlackStreamNotDeliveredError(
      text,
      oversized ? "team_not_found" : "user_not_found",
    );
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.pendingText = text;
      throw rejection;
    });
    if (nativeStopSucceeds) {
      stopSlackStreamMock.mockImplementationOnce(async () => {
        session.pendingText = "";
        return { messageId: STREAM_MESSAGE_TS };
      });
    } else {
      stopSlackStreamMock.mockRejectedValueOnce(rejection);
    }
    const result = await dispatch().catch((error: unknown) => error);
    expect(result).toBeUndefined();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(nativeStopSucceeds ? 0 : 1);
    if (oversized) {
      expect(postMessageMock).not.toHaveBeenCalled();
      expectDeliverReplyCall(0, text, { textLimit: 4000 });
      expect(session.stopped).toBe(true);
    } else {
      expect(stopSlackStreamMock).toHaveBeenCalledOnce();
      expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
      expectSentHook(0, "already visible", { messageId: STREAM_MESSAGE_TS });
      expectSentHook(1, text, { success: nativeStopSucceeds, messageId: STREAM_MESSAGE_TS });
    }
  },
);

it.each<{
  name: string;
  events: SlackReplyOptionEvent[];
  updates: unknown[];
  progress?: Parameters<typeof dispatchNativeProgressScenario>[0]["progress"];
  tasks?: unknown[];
  completion?: unknown[];
  finalInStream?: boolean;
}>([
  {
    name: "typed plan steps",
    events: [
      {
        kind: "plan",
        phase: "update",
        explanation: "Executing the checklist.",
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Patch", status: "in_progress" },
          { step: "Test", status: "pending" },
        ],
      },
    ],
    updates: [
      planUpdate("Executing the checklist."),
      taskUpdate("plan_step_1", "Inspect", "complete"),
      taskUpdate("plan_step_2", "Patch", "in_progress"),
      taskUpdate("plan_step_3", "Test", "pending"),
    ],
  },
  {
    name: "deduplicated preamble and prepared note",
    events: [
      preamble("Checking results", "preamble-1"),
      {
        kind: "plan",
        phase: "update",
        ...projectProgressCardChannelUpdate({ markdown: "**Checking** results" }),
        steps: [],
      },
    ],
    updates: [
      planUpdate("Checking results"),
      taskUpdate(expect.any(String), "Update Plan", "in_progress", { details: "Checking results" }),
    ],
  },
  {
    name: "configured command truncation",
    progress: { label: "Shelling", maxLineChars: 12, nativeTaskCards: true, commandText: "raw" },
    events: [
      {
        kind: "tool_start",
        itemId: "exec-call-1",
        toolCallId: "tool-call-1",
        name: "bash",
        phase: "start",
        args: { command: "1234567890abcdefghijklmnopqrstuvwxyz" },
      },
    ],
    updates: [
      planUpdate("Shelling"),
      taskUpdate(expect.stringMatching(/^exec_call_1_[a-f0-9]{8}$/), "Bash", "in_progress", {
        details: "12345…uvwxyz",
      }),
    ],
    completion: [
      taskUpdate(expect.stringMatching(/^exec_call_1_[a-f0-9]{8}$/), "Bash", "complete"),
    ],
  },
  {
    name: "patch item identity",
    events: [
      {
        kind: "patch",
        itemId: "patch:item-1",
        toolCallId: "patch-call-1",
        name: "apply_patch",
        phase: "end",
        summary: "updated Slack progress tests",
      },
    ],
    updates: [
      planUpdate("Apply Patch — updated Slack progress tests"),
      taskUpdate(expect.stringMatching(/^patch_item_1_[a-f0-9]{8}$/), "Apply Patch", "complete", {
        details: "updated Slack progress tests",
      }),
    ],
    tasks: [
      taskUpdate(expect.stringMatching(/^patch_item_1_[a-f0-9]{8}$/), "Apply Patch", "complete", {
        details: "updated Slack progress tests",
      }),
    ],
    finalInStream: true,
  },
])(
  "renders native progress from $name",
  async ({ events, updates, progress, tasks, completion, finalInStream }) => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events,
      progress,
    });
    expectNativeProgressStart(updates);
    if (tasks) {
      expect(collectNativeTaskUpdates()).toEqual(tasks);
    }
    if (completion) {
      expectNativeProgressAppend(0, completion);
    }
    if (finalInStream) {
      expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
    }
  },
);

it.each([true, false])(
  "retracts a native model-wait headline before the final reply (detailed=%s)",
  async (toolProgress) => {
    const waitText = "Waiting for the local model to respond";
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      progress: { style: "card", nativeTaskCards: true, toolProgress },
      events: [
        { kind: "item", itemKind: "model-wait", phase: "update", progressText: waitText },
        checkpoint(async () => {
          const start = requireRecord(startSlackStreamMock.mock.calls[0]?.[0], "wait start");
          expect(start.chunks).toContainEqual(planUpdate(waitText));
        }),
        { kind: "item", itemKind: "model-wait", phase: "end" },
        checkpoint(async () => {
          const clear = requireRecord(appendSlackStreamMock.mock.calls.at(-1)?.[0], "wait clear");
          expect(clear.chunks).toContainEqual(planUpdate(toolProgress ? "Thinking" : "Working"));
        }),
      ],
    });
    expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  },
);

it("streams rolling reasoning snapshots as deduplicated narration", async () => {
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    events: [
      { kind: "reasoning", text: "Checking", isReasoningSnapshot: true },
      { kind: "reasoning", text: "Checking the Slack handler", isReasoningSnapshot: true },
    ],
  });

  expect(collectNativeTaskUpdates()).toEqual([]);
  expectNativeStreamText("Checking");
  // A snapshot arriving inside the throttle window rides the completion append.
  expectNativeProgressAppend(0, [{ type: "markdown_text", text: " the Slack handler" }]);
  expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
});

it("keeps final fallback in the planned thread when native Slack progress start fails", async () => {
  startSlackStreamMock.mockRejectedValueOnce(new Error("start stream failed"));
  mockedReplyThreadTsSequence = [THREAD_TS, undefined];

  await dispatchNativeProgressScenario({
    replyToMode: "first",
    finalPayload: { text: FINAL_REPLY_TEXT },
    events: [{ kind: "item", progressText: "slow tool" }],
  });

  expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
  expectNoCalls(appendSlackStreamMock, stopSlackStreamMock);
  expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
});

it("places a native-streamed final below a later human message in the same thread", async () => {
  const sessions = recordNativeSessions();
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    events: [approval("inspect"), await humanReplyCheckpoint()],
  });

  expectNativeRotation();
  expectMockCallArgFields(stopSlackStreamMock, 0, { session: sessions[0] });
  expectMockCallArgFields(stopSlackStreamMock, 1, { session: sessions[1] });
  expectMockCallArgFields(startSlackStreamMock, 1, { threadTs: THREAD_TS, text: FINAL_REPLY_TEXT });
  expectNativeStreamText(FINAL_REPLY_TEXT, 1);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
  expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(1);
});

it("rotates a top-level native stream when a later human enters through Slack ingress", async () => {
  const { createSlackSystemEventTestHarness } =
    await import("../events/system-event-test-harness.js");
  const { registerSlackMessageEvents } = await import("../events/messages.js");
  const ingress = createSlackSystemEventTestHarness({ channelType: "channel" });
  registerSlackMessageEvents({ ctx: ingress.ctx, handleSlackMessage: async () => {} });
  const handleHumanMessage = ingress.getHandler("message");
  if (!handleHumanMessage) {
    throw new Error("expected registered Slack message ingress");
  }
  startSlackStreamMock.mockImplementation(async () => createNativeStreamSession());
  mockedNativeStreaming = true;
  mockedDispatchSequence = [
    textReply("visible A", "block"),
    checkpoint(async () => {
      expect(startSlackStreamMock).toHaveBeenCalledOnce();
      await handleHumanMessage({
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U_HUMAN",
          text: "human B",
          ts: "171234.568",
        },
        body: { api_app_id: "A_TEST" },
      });
    }),
    textReply("answer C"),
  ];

  await dispatch({ replyToMode: "all", message: { thread_ts: undefined } });

  expectNativeRotation();
  expectMockCallArgFields(startSlackStreamMock, 0, { text: "visible A", threadTs: THREAD_TS });
  expectMockCallArgFields(startSlackStreamMock, 1, { text: "answer C", threadTs: THREAD_TS });
  expectNativeStreamText("answer C", 1);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it.each([
  { timing: "before sealing", duringSeal: false, isError: false },
  { timing: "while sealing", duringSeal: true, isError: false },
  { timing: "while sealing a non-streamable final", duringSeal: true, isError: true },
])("preserves native Stop $timing and suppresses a late final", async ({ duringSeal, isError }) => {
  const session = { ...createNativeStreamSession(), stoppedBySlack: false };
  startSlackStreamMock.mockResolvedValueOnce(session);
  if (duringSeal) {
    stopSlackStreamMock.mockImplementationOnce(async () => {
      session.stoppedBySlack = true;
      return {};
    });
  }
  const { noteSlackDraftConversationMessage } = await import("../../draft-message-boundaries.js");
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT, ...(isError ? { isError: true } : {}) },
    events: [
      { kind: "approval", phase: "requested", approvalId: "approval-1", command: "inspect" },
      checkpoint(async () => {
        expect(startSlackStreamMock).toHaveBeenCalledOnce();
        noteSlackDraftConversationMessage(HUMAN_THREAD_REPLY);
        if (!duringSeal) {
          session.stopped = true;
          session.stoppedBySlack = true;
        }
      }),
    ],
  });

  expect(startSlackStreamMock).toHaveBeenCalledOnce();
  expect(stopSlackStreamMock).toHaveBeenCalledTimes(duringSeal ? 1 : 0);
  expectNativeStreamText(FINAL_REPLY_TEXT, 0);
  expectNoCalls(deliverRepliesMock, emitSlackMessageSentHooksMock);
});

it("rotates a native reply when a human arrives before the first stream receipt", async () => {
  const { noteSlackDraftConversationMessage } = await import("../../draft-message-boundaries.js");
  mockedNativeStreaming = true;
  mockedDispatchSequence = [textReply("visible A", "block"), textReply("answer after B")];
  startSlackStreamMock
    .mockImplementationOnce(async () => {
      noteSlackDraftConversationMessage(HUMAN_THREAD_REPLY);
      return createNativeStreamSession();
    })
    .mockImplementationOnce(async () => createNativeStreamSession());

  await dispatch();

  expectCalls(2, startSlackStreamMock, stopSlackStreamMock);
  expectMockCallArgFields(startSlackStreamMock, 0, { text: "visible A", threadTs: THREAD_TS });
  expectMockCallArgFields(startSlackStreamMock, 1, { text: "answer after B", threadTs: THREAD_TS });
  expect(deliverRepliesMock).not.toHaveBeenCalled();
  expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
});

it("starts later native task progress below a human reply with a fresh task snapshot", async () => {
  startSlackStreamMock.mockImplementation(async () => createNativeStreamSession());
  await dispatchNativeProgressScenario({
    finalPayload: { text: FINAL_REPLY_TEXT },
    events: [
      approval("continue"),
      await humanReplyCheckpoint(),
      approval("verify", "approval-2"),
      checkpoint(async () => {
        expect(startSlackStreamMock).toHaveBeenCalledTimes(2);
      }),
    ],
  });

  expectCalls(2, startSlackStreamMock, stopSlackStreamMock);
  expectMockCallArgFields(startSlackStreamMock, 1, { threadTs: THREAD_TS });
  const secondStart = mockRecord(startSlackStreamMock, 1);
  expect(secondStart.chunks).toEqual(
    expect.arrayContaining([
      taskUpdate(
        expect.stringMatching(/^openclaw-attention-/u),
        expect.stringContaining("verify"),
        "pending",
      ),
    ]),
  );
  expect(deliverRepliesMock).not.toHaveBeenCalled();
});

it("rebuilds native task rows when a block reply rotates the stream before progress", async () => {
  const sessions = recordNativeSessions();
  mockedNativeStreaming = true;
  mockedSlackStreamingMode = "progress";
  mockedReplyOptionEvents = [approval("inspect"), await humanReplyCheckpoint()];
  mockedDispatchSequence = [
    textReply("working after B", "block"),
    checkpoint(async () => {
      expect(startSlackStreamMock).toHaveBeenCalledTimes(2);
      const onApprovalEvent = capturedReplyOptions?.onApprovalEvent;
      if (!onApprovalEvent) {
        throw new Error("expected approval event handler");
      }
      await onApprovalEvent({ phase: "requested", approvalId: "approval-2", command: "verify" });
    }),
    checkpoint(async () => {
      const secondStreamUpdates = appendSlackStreamMock.mock.calls
        .filter(([value]) => requireRecord(value, "native append").session === sessions[1])
        .flatMap(([value]) => {
          const chunks = requireRecord(value, "native append").chunks;
          return Array.isArray(chunks) ? chunks : [];
        });
      expect(secondStreamUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "task_update",
            title: expect.stringContaining("inspect"),
          }),
          expect.objectContaining({
            type: "task_update",
            title: expect.stringContaining("verify"),
          }),
        ]),
      );
    }),
    textReply(FINAL_REPLY_TEXT),
  ];

  await dispatchProgress({ toolProgress: true, nativeTaskCards: true });

  expectCalls(2, startSlackStreamMock, stopSlackStreamMock);
  expectMockCallArgFields(startSlackStreamMock, 1, { threadTs: THREAD_TS });
});

it("settles a failed native progress rotation before starting the queued turn", async () => {
  const firstSession = createNativeStreamSession();
  const secondSession = { ...firstSession };
  startSlackStreamMock.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession);
  stopSlackStreamMock
    .mockRejectedValueOnce(new Error("socket reset"))
    .mockResolvedValueOnce({ messageId: "171234.702" });
  finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
  mockedNativeStreaming = true;

  mockedReplyOptionEvents = [{ kind: "item", progressText: "first tool" }];
  mockedDispatchSequence = [
    textReply("same answer"),
    { kind: "queued_followup" },
    { kind: "item", progressText: "queued tool" },
    textReply("same answer"),
  ];

  await dispatchProgress({ toolProgress: true, nativeTaskCards: true });

  expectNativeRotation();
  expectNoCalls(deliverRepliesMock, finalizeSlackPreviewEditMock);
  expectNativeStreamText("\nsame answer", 2);
  expectMockCallArgFields(stopSlackStreamMock, 0, { session: firstSession });
  expectMockCallArgFields(stopSlackStreamMock, 1, { session: secondSession });
});

it("completes a native Slack progress plan even when no final text is sent", async () => {
  await dispatchNativeProgressScenario({
    events: [{ kind: "concurrent_items", progressTexts: ["tool one", "tool two", "tool three"] }],
  });

  expectNativeProgressStart([
    planUpdate("tool three"),
    taskUpdate(contentTaskId("item"), "tool one", "in_progress"),
    taskUpdate(contentTaskId("item"), "tool two", "in_progress"),
    taskUpdate(contentTaskId("item"), "tool three", "in_progress"),
  ]);
  expectNoCalls(appendSlackStreamMock, deliverRepliesMock);
  expectMockCallArgFields(stopSlackStreamMock, 0, {
    chunks: [
      taskUpdate(contentTaskId("item"), "tool one", "complete"),
      taskUpdate(contentTaskId("item"), "tool two", "complete"),
      taskUpdate(contentTaskId("item"), "tool three", "complete"),
    ],
  });
});

it("re-arms an isolated progress draft on an assistant boundary after final delivery", async () => {
  const draftStream = useDraftStream(true);

  mockedReplyOptionEvents = [{ kind: "item", progressText: "first turn" }];

  await dispatchProgress();
  await capturedReplyOptions?.onAssistantMessageStart?.();
  await requireCapturedItemEventHandler()({ progressText: "second turn" });

  expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  expect(finalizeSlackPreviewEditMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
    draftStream.forceNewMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
  expectLastDraftUpdateText(draftStream, "Working\n\n_second turn_\n\n1s");
});

it.each([false, true])("clears settled queued progress (quiet=%s)", async (quiet) => {
  const draftStream = useDraftStream();
  mockedDispatchSequence = [];
  mockedReplyOptionEvents = quiet ? [] : [{ kind: "item", progressText: "silent turn" }];
  await dispatchProgress(
    quiet ? { label: false, commentary: true, toolProgress: false, maxLines: 1 } : undefined,
  );
  await capturedReplyOptions?.onQueuedFollowupAdmitted?.();
  await requireCapturedItemEventHandler()(
    quiet
      ? { kind: "preamble", itemId: "queued-preamble", progressText: "Checking the followup" }
      : { progressText: "queued turn" },
  );
  if (quiet) {
    expectLastDraftUpdateText(draftStream, "_Checking the followup_");
  } else {
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  }
  const clearCalls = draftStream.clear.mock.calls.length;
  const dropCalls = draftStream.dropDetachedMessages.mock.calls.length;
  await capturedReplyOptions?.onQueuedFollowupSettled?.();
  expect(draftStream.clear).toHaveBeenCalledTimes(clearCalls + 1);
  expect(draftStream.clear.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
    draftStream.update.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
  );
  if (quiet) {
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  } else {
    expectLastDraftUpdateText(draftStream, "Working\n\n_queued turn_\n\n1s");
    expect(draftStream.dropDetachedMessages).toHaveBeenCalledTimes(dropCalls + 1);
    expect(draftStream.dropDetachedMessages.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      draftStream.clear.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
  }
});

it.each([
  { humanReply: false, messageToolReply: false, silent: false },
  { humanReply: true, messageToolReply: false, silent: false },
  { humanReply: true, messageToolReply: true, silent: false },
  { humanReply: true, messageToolReply: false, silent: true },
])(
  "settles interrupted previews without losing human context (human=$humanReply, message tool=$messageToolReply, silent=$silent)",
  async ({ humanReply, messageToolReply, silent }) => {
    mockedSlackStreamingMode = "partial";
    mockedDispatchSequence = messageToolReply || silent ? [] : [textReply(FINAL_REPLY_TEXT)];
    mockedSourceReplyDelivered = messageToolReply;
    const { createSlackDraftStream } =
      await vi.importActual<typeof import("../../draft-stream.js")>("../../draft-stream.js");
    const { noteSlackDraftConversationMessage } = await import("../../draft-message-boundaries.js");
    const visibleMessages = new Map<string, string>();
    let nextMessageId = 100;
    let draftStream: ReturnType<typeof createSlackDraftStream> | undefined;
    let noteHumanReply = () => {};
    createSlackDraftStreamMock.mockImplementationOnce(
      (params: Parameters<typeof createSlackDraftStream>[0]) => {
        sendMessageSlackMock.mockImplementation(async (_target, text) => {
          const messageId = String(nextMessageId++);
          visibleMessages.set(messageId, text);
          return {
            channelId: "C123",
            messageId,
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "slack", channelId: "C123", messageId }],
              kind: "preview",
            }),
          };
        });
        const edit = async (_channelId: string, messageId: string, text: string) => {
          visibleMessages.set(messageId, text);
        };
        editSlackMessageMock.mockImplementation(edit);
        editSlackRenderedMessageMock.mockImplementation(edit);
        deleteSlackMessageMock.mockImplementation(async (_channelId, messageId) => {
          visibleMessages.delete(messageId);
        });
        draftStream = createSlackDraftStream(params);
        noteHumanReply = () =>
          noteSlackDraftConversationMessage({
            accountId: params.accountId,
            teamId: params.eventScope?.teamId,
            channelId: "C123",
            threadTs: params.resolveThreadTs?.(),
            messageTs: String(nextMessageId++),
            userId: "U_HUMAN",
          });
        return draftStream;
      },
    );
    finalizeSlackPreviewEditMock.mockImplementationOnce(async (input) => {
      const edit = requireRecord(input, "final preview edit");
      visibleMessages.set(String(edit.messageId), String(edit.text));
    });
    mockedReplyOptionEvents = [
      { kind: "partial", text: "I will inspect the files." },
      checkpoint(async () => {
        await draftStream?.flush();
        expect([...visibleMessages.values()]).toEqual(["I will inspect the files."]);
        if (humanReply) {
          noteHumanReply();
        }
        if (messageToolReply) {
          visibleMessages.set("message-tool-reply", FINAL_REPLY_TEXT);
        }
      }),
      { kind: "assistant_start" },
      ...(messageToolReply || silent ? [] : [{ kind: "partial" as const, text: FINAL_REPLY_TEXT }]),
    ];

    await dispatch();
    draftStream?.update("Late preview after final delivery");
    await draftStream?.flush();

    expect([...visibleMessages.values()]).toEqual(
      silent
        ? []
        : humanReply
          ? ["I will inspect the files.", FINAL_REPLY_TEXT]
          : [FINAL_REPLY_TEXT],
    );
  },
);

it("starts a new draft delivery target when a queued followup is admitted", async () => {
  const draftStream = useDraftStream();
  mockedSlackStreamingMode = "partial";
  mockedDispatchSequence = [];
  mockedReplyOptionEvents = [{ kind: "partial", text: "first reply" }];

  await dispatch({});
  await capturedReplyOptions?.onQueuedFollowupAdmitted?.();

  expect(draftStream.flush).toHaveBeenCalledTimes(1);
  expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
});

it("keeps complete preambles visible between streamed updates", async () => {
  const checkpoints = vi.fn();
  let postedMessageId: string | undefined;
  const draftStream = {
    ...createDraftStreamStub(),
    messageId: () => postedMessageId,
  };
  draftStream.flush.mockImplementation(async () => {
    if (draftStream.update.mock.calls.length > 0) {
      postedMessageId = "171234.567";
    }
  });
  createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
  finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);

  mockedReplyOptionEvents = [
    preamble("I", "p1", "update"),
    checkpoint(async () => {
      // Even a timer/flush must not post the first token: Slack freezes
      // its push notification at creation, then edits do not re-notify.
      checkpoints();
      await draftStream.flush();
      expect(draftStream.update).not.toHaveBeenCalled();
      expect(postedMessageId).toBeUndefined();
    }),
    preamble("I will check the result.", "p1", "update"),
    checkpoint(async () => {
      checkpoints();
      expect(draftStream.update).not.toHaveBeenCalled();
    }),
    preamble("I will check the result.", "p1", "end"),
    checkpoint(async () => {
      checkpoints();
      expect(postedMessageId).toBe("171234.567");
      expect(draftUpdateTexts(draftStream)).toEqual(["_I will check the result._"]);
    }),
    preamble("The result", "p2", "update"),
    checkpoint(async () => {
      checkpoints();
      // A human reply can rotate the preview at this point. Keeping the
      // last complete preamble prevents an abandoned word fragment.
      expect(draftUpdateTexts(draftStream)).toEqual(["_I will check the result._"]);
      expect(draftStream.update.mock.calls.at(-1)?.[0]).toMatchObject({ allowNewMessage: true });
    }),
    preamble("The result is ready.", "p2", "end"),
  ];

  await dispatchProgress({ label: false, commentary: true, toolProgress: false, maxLines: 1 });

  // Assert the intermediate observations ran; the final text alone cannot
  // prove that Slack never received a first-token notification.
  expect(checkpoints).toHaveBeenCalledTimes(4);
  expectLastDraftUpdateText(draftStream, "_The result is ready._");
  expect(draftStream.update.mock.calls.at(-1)?.[0]).toMatchObject({ allowNewMessage: true });
  expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
});

it.each([false, true])(
  "keeps the latest Slack preamble (tool progress=%s)",
  async (toolProgress) => {
    const draftStream = useDraftStream();
    mockedDispatchSequence = [];
    const first = toolProgress ? "Checking the legacy Slack path" : "Checking the Slack event path";
    const latest = toolProgress ? "Keeping the released behavior" : "Preparing the smallest fix";
    mockedReplyOptionEvents = [
      toolStart({ command: "pnpm test" }, { itemId: "tool-1" }),
      preamble(first, "preamble-1"),
      preamble(latest, "preamble-2"),
    ];
    await dispatchProgress({
      label: false,
      ...(!toolProgress ? { commentary: true } : {}),
      toolProgress,
      maxLines: 1,
    });
    if (toolProgress) {
      expectRecordFields(requireRecord(capturedReplyOptions, "reply options"), {
        commentaryProgressEnabled: undefined,
        commentaryPayloadsEnabled: undefined,
        shouldDeliverCommentaryPayloads: undefined,
        onVerboseProgressVisibilityAsync: undefined,
        progressPreambleEnabled: true,
      });
      expectLastDraftUpdateText(draftStream, `_${latest}_\n\nBash — running\n\n1 tool · 1s`);
    } else {
      expect(capturedReplyOptions?.commentaryProgressEnabled).toBe(true);
      expect(capturedReplyOptions?.commentaryPayloadsEnabled).toBe(true);
      expect(capturedReplyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(false);
      expect(capturedReplyOptions?.suppressDefaultToolProgressMessages).toBe(true);
      expectLastDraftUpdateText(draftStream, `_${latest}_`);
      expect(draftUpdateTexts(draftStream).join("\n")).not.toContain("pnpm test");
      const updateCount = draftStream.update.mock.calls.length;
      await capturedReplyOptions?.onVerboseProgressVisibilityAsync?.(async () => true);
      expect(capturedReplyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(true);
      await requireCapturedItemEventHandler()({
        kind: "preamble",
        itemId: "preamble-3",
        progressText: "Delivered by the verbose lane",
      });
      expect(draftStream.update).toHaveBeenCalledTimes(updateCount);
    }
  },
);

it("escapes Slack mentions and renders commentary without losing outer italics or inline code", async () => {
  const { normalizeSlackOutboundText } =
    await vi.importActual<typeof import("../../format.js")>("../../format.js");
  const draftStream = useDraftStream();

  mockedDispatchSequence = [];
  mockedReplyOptionEvents = [
    preamble(
      "checking <@U123> in <#C123> and <!channel> with *urgent* _context_ `src/one.ts` & Linux x86_64",
      "preamble-1",
    ),
  ];

  await normalizeSlackOutboundTextMock.withImplementation(normalizeSlackOutboundText, async () => {
    await dispatchProgress({ label: false, commentary: true, toolProgress: false });
  });

  expectLastDraftUpdateText(
    draftStream,
    "_checking &lt;@U123&gt; in &lt;#C123&gt; and &lt;!channel&gt; with urgent context `src/one.ts` &amp; Linux x86_64_",
  );
});

it("keeps only preambles through reasoning and failed tools by default", async () => {
  const draftStream = useDraftStream(true);

  mockedReplyOptionEvents = [
    checkpoint(async () => {
      if (!capturedReplyOptions) {
        throw new Error("expected Slack reply options");
      }
      await emitCompactProgressScenario(capturedReplyOptions);
    }),
  ];

  await dispatchProgress({ nativeTaskCards: true, label: false, toolProgress: false, maxLines: 1 });

  expect(createSlackDraftStreamMock).toHaveBeenCalledTimes(1);
  expectNoCalls(startSlackStreamMock, appendSlackStreamMock, stopSlackStreamMock);
  expect(
    draftStream.update.mock.calls.every(
      ([update]) => typeof update === "string" || !("blocks" in update),
    ),
  ).toBe(true);
  expect(draftUpdateTexts(draftStream)).toEqual([
    "Checking the current Slack behavior.",
    "The fix is ready; I’m checking the result.",
  ]);
  expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
  expect(deliverRepliesMock).toHaveBeenCalledOnce();
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  expect(draftStream.discardPending.mock.invocationCallOrder[0]).toBeLessThan(
    deliverRepliesMock.mock.invocationCallOrder[0]!,
  );
  expect(deliverRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
    draftStream.clear.mock.invocationCallOrder[0]!,
  );
});

it("publishes compact media finals before clearing the preview after a suppressed send", async () => {
  const draftStream = useDraftStream();

  const payload = { text: "The fix works.", mediaUrl: "https://example.com/demo.mp4" };
  mockedDispatchSequence = [finalReply(payload), finalReply(payload)];
  deliverRepliesMock.mockResolvedValueOnce(undefined);
  deliverRepliesMock.mockImplementationOnce(async () => {
    expect(draftStream.clear).not.toHaveBeenCalled();
    return normalDeliveryResult;
  });

  await dispatchProgress({ style: "compact" });

  expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
  expect(deliverRepliesMock).toHaveBeenCalledWith(
    expect.objectContaining({ replies: [payload], replyThreadTs: THREAD_TS }),
  );
  expect(draftStream.clear).toHaveBeenCalled();
  expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
});

it("retracts and resumes Slack plans while retaining other block progress", async () => {
  const draftStream = useDraftStream();
  mockedSlackStreamingMode = "block";
  mockedDispatchSequence = [];
  mockedReplyOptionEvents = [
    planEvent("Inspect"),
    { kind: "assistant_start" },
    { kind: "plan", phase: "update", steps: [] },
    checkpoint(async () => {
      expect(draftStream.clear).toHaveBeenCalledTimes(1);
      expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    }),
    planEvent("Resume"),
    { kind: "assistant_start" },
    {
      kind: "item",
      itemId: "card-rejected",
      itemKind: "tool",
      name: "progress_card",
      phase: "end",
      status: "blocked",
    },
    { kind: "assistant_start" },
    { kind: "item", itemId: "independent", progressText: "Independent work" },
    checkpoint(async () => {
      const text = draftUpdateTexts(draftStream).at(-1);
      expect(text).toContain("Independent work");
      expect(text).toContain("blocked");
      expect(text).toContain("▸ Resume");
    }),
    { kind: "assistant_start" },
    { kind: "plan", phase: "update", steps: [] },
    checkpoint(async () => {
      const text = draftUpdateTexts(draftStream).at(-1);
      expect(text).toContain("Independent work");
      expect(text).toContain("blocked");
      expect(text).not.toContain("Resume");
      expect(draftStream.clear).toHaveBeenCalledTimes(1);
    }),
  ];

  await dispatch({
    accountConfig: { streaming: { mode: "block", progress: { label: false } } },
  });
});

it("keeps one partial preview across reasoning and tool boundaries", async () => {
  const draftStream = useDraftStream();
  mockedDispatchSequence = [];
  mockedReplyOptionEvents = [
    { kind: "reasoning", text: "Checking the first path" },
    { kind: "reasoning_end" },
    { kind: "item", progressText: "ran <!here> <@U123> *bold* `code` & done" },
    { kind: "assistant_start" },
    { kind: "reasoning", text: "Checking the second path" },
    { kind: "reasoning_end" },
    { kind: "item", progressText: "tool two" },
    { kind: "assistant_start" },
    { kind: "partial", text: "final answer" },
  ];

  await dispatch({
    accountConfig: {
      streaming: { mode: "partial", progress: { label: false } },
    },
  });

  expect(draftUpdateTexts(draftStream).join("\n")).toContain(
    "ran &lt;!here&gt; &lt;@U123&gt; *bold* `code` &amp; done",
  );
  expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
  expect(draftStream.update).toHaveBeenLastCalledWith("final answer");
});

it("resolves and caches the native stream recipient team per enterprise client", async () => {
  mockedNativeStreaming = true;
  const usersInfo = vi.fn(async () => ({ user: { team_id: "T_RECIPIENT" } }));
  const eventClient = {
    chat: { postMessage: postMessageMock, update: chatUpdateMock },
    users: { info: usersInfo },
  };
  const eventScope = { teamId: "T_ENTERPRISE", client: eventClient };

  await dispatch({ eventScope });
  await dispatch({ eventScope });

  expect(usersInfo).toHaveBeenCalledTimes(1);
  expect(usersInfo).toHaveBeenCalledWith({ token: "xoxb-test", user: "U123" });
  expectMockCallArgFields(startSlackStreamMock, 0, { client: eventClient, teamId: "T_RECIPIENT" });
  expectMockCallArgFields(startSlackStreamMock, 1, { client: eventClient, teamId: "T_RECIPIENT" });
});

it("suppresses reasoning payloads during a definite stream-rejection fallback", async () => {
  mockedNativeStreaming = true;
  mockedDispatchSequence = [
    { kind: "block", payload: { text: "Let me analyze...", isReasoning: true } },
    textReply(FINAL_REPLY_TEXT),
  ];
  startSlackStreamMock.mockRejectedValueOnce(
    new TestSlackStreamNotDeliveredError(FINAL_REPLY_TEXT, "missing_scope"),
  );

  await dispatch();

  expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
});

it("keeps same-content tool and final payloads distinct after preview fallback", async () => {
  mockedDispatchSequence = [textReply(SAME_TEXT, "tool"), textReply(SAME_TEXT)];

  await dispatch();

  expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
  expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
  expectDeliverReplyCall(0, SAME_TEXT);
  expectDeliverReplyCall(1, SAME_TEXT);
});

it("keeps multi-part block replies in the first reply thread after the plan is consumed", async () => {
  mockedReplyThreadTsSequence = [THREAD_TS, undefined];
  mockedDispatchSequence = [textReply("first block", "block"), textReply("second block", "block")];

  await dispatch({ replyToMode: "first" });

  expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
  expectDeliverReplyCall(0, "first block");
  expectDeliverReplyCall(1, "second block");
});

it("preserves normal final delivery when stale-preview cleanup fails", async () => {
  const draftStream = createDraftStreamStub();
  draftStream.clear.mockRejectedValueOnce(new Error("preview cleanup failed"));
  createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
  mockedDispatchSequence = [finalReply({ text: "Photo", mediaUrl: "https://example.com/a.png" })];

  await dispatch();

  expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
});

it.each(["interrupted", "already-visible", "chart"] as const)(
  "preserves TTS text and media through %s preview fallback",
  async (scenario) => {
    let messageId: string | undefined = "171234.567";
    const draftStream = {
      ...createDraftStreamStub(),
      messageId: () => messageId,
      channelId: () => (messageId ? "C123" : undefined),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    const spokenText = "Spoken answer";
    const previouslyVisible = scenario === "already-visible";
    if (scenario === "interrupted") {
      draftStream.flush.mockImplementation(async () => {
        messageId = undefined;
      });
    } else {
      mockedReplyThreadTsSequence = [undefined];
    }
    if (scenario === "chart") {
      mockedSlackReplyBlocks = [
        { type: "section", text: { type: "mrkdwn", text: "Spoken answer", verbatim: true } },
        {
          type: "data_visualization",
          title: "Revenue",
          chart: {
            type: "bar",
            series: [
              {
                name: "<@U123>",
                data: [
                  { label: "Q1", value: 12 },
                  { label: "Q2", value: 18 },
                ],
              },
            ],
            axis_config: { categories: ["Q1", "Q2"] },
          },
        },
      ];
    }
    const payload = {
      ...ttsPayload(spokenText, previouslyVisible),
      ...(scenario === "chart"
        ? {
            presentation: {
              blocks: [
                {
                  type: "chart",
                  chartType: "bar",
                  title: "Revenue",
                  categories: ["Q1", "Q2"],
                  series: [{ name: "<@U123>", values: [12, 18] }],
                },
              ],
            },
          }
        : {}),
    };
    mockedDispatchSequence = [{ kind: "final", payload }];
    await dispatch();
    expect(delivered().replies).toEqual([{ ...payload, text: spokenText }]);
    if (scenario === "chart") {
      expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, {
        text: "Spoken answer\n\nRevenue (bar chart)\n- &lt;@U123&gt;: Q1: 12; Q2: 18",
        blocks: mockedSlackReplyBlocks,
      });
      expect(normalizeSlackOutboundTextMock).not.toHaveBeenCalled();
    } else if (scenario === "already-visible") {
      expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
      expect(draftStream.discardPending).toHaveBeenCalled();
      expectRecordFields(delivered(), { replyThreadTs: THREAD_TS });
    } else {
      expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
      expect(deliverRepliesMock).toHaveBeenCalledOnce();
    }
  },
);

it("defers hooks and suppresses duplicate TTS finals when flush creates the preview id", async () => {
  let flushed = false;
  const draftStream = {
    ...createDraftStreamStub(),
    flush: vi.fn(async () => {
      flushed = true;
    }),
    messageId: () => (flushed ? "171234.567" : undefined),
  };
  createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
  finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
  mockedSlackIsThreadReply = false;
  mockedReplyThreadTsSequence = [undefined, undefined];
  const payload = { ...ttsPayload(), text: "Spoken answer" };
  mockedDispatchSequence = [finalReply(payload), finalReply(payload)];

  await dispatch({
    message: { thread_ts: undefined },
    replyToMode: "first",
  });

  expectCalls(1, finalizeSlackPreviewEditMock, deliverRepliesMock);
  const delivery = delivered(0);
  expectRecordFields(delivery, { replyThreadTs: THREAD_TS });
  expect(emitSlackMessageSentHooksMock).not.toHaveBeenCalled();
});

it("awaits the Slack receipt for a short tool reply", async () => {
  mockedNativeStreaming = true;
  mockedDispatchSequence = [textReply("short reply", "tool")];
  let acknowledgedBeforeStop = false;
  startSlackStreamMock.mockImplementationOnce(async (input) => {
    const params = requireRecord(input, "stream start");
    return {
      ...createNativeStreamSession(),
      delivered: Array.isArray(params.chunks),
      pendingText: Array.isArray(params.chunks) ? "" : "short reply",
    };
  });
  stopSlackStreamMock.mockImplementationOnce(async (input) => {
    const params = requireRecord(input, "stream stop");
    acknowledgedBeforeStop = requireRecord(params.session, "stream session").delivered === true;
    return {};
  });

  await dispatch();

  expectMockCallArgFields(startSlackStreamMock, 0, { text: "short reply", chunks: [] });
  expect(acknowledgedBeforeStop).toBe(true);
  expect(deliverRepliesMock).not.toHaveBeenCalled();
  expect(emitSlackMessageSentHooksMock).toHaveBeenCalledOnce();
});

it.each(["update", "completion"])(
  "keeps acknowledged narration successful when optional progress %s fails",
  async (phase) => {
    mockedNativeStreaming = true;
    mockedSlackStreamingMode = "progress";
    mockedReplyOptionEvents =
      phase === "completion" ? [{ kind: "item", progressText: "working" }] : [];
    mockedDispatchSequence = [
      textReply("acknowledged narration", "block"),
      ...(phase === "update" ? [{ kind: "item" as const, progressText: "working" }] : []),
      textReply(FINAL_REPLY_TEXT),
    ];
    const session = createNativeStreamSession();
    startSlackStreamMock.mockResolvedValueOnce(session);
    if (phase === "completion") {
      appendSlackStreamMock.mockResolvedValueOnce(undefined);
    }
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.stopped = true;
      throw new Error("network socket closed");
    });

    await dispatch();

    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledOnce();
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: "acknowledged narration",
        success: true,
        messageId: STREAM_MESSAGE_TS,
      }),
    );
  },
);

it.each([true, false])(
  "preserves native Stop with an acknowledged append: %s",
  async (acknowledged) => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      textReply("already visible"),
      textReply("stopped reply"),
      textReply("after Stop"),
    ];
    const session = { ...createNativeStreamSession(), stoppedBySlack: false };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.stopped = true;
      session.stoppedBySlack = true;
      session.pendingText = acknowledged ? "" : "stopped reply";
    });

    await dispatch();

    expect(appendSlackStreamMock).toHaveBeenCalledOnce();
    expectNoCalls(stopSlackStreamMock, deliverRepliesMock);
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
    expectSentHook(0, "already visible");
    expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, {
      content: "stopped reply",
      success: acknowledged,
      ...(acknowledged ? { messageId: STREAM_MESSAGE_TS } : { error: "Stopped by Slack user" }),
    });
  },
);

it.each(["acknowledged-final", "append", "stop"] as const)(
  "preserves delivery acknowledgement without replay after %s loses its response",
  async (operation) => {
    mockedNativeStreaming = true;
    const acknowledged = operation === "acknowledged-final";
    const error = new Error("network socket closed");
    if (!acknowledged) {
      mockedDispatchSequence = [
        textReply("already visible"),
        textReply("second acknowledged", "block"),
        textReply("failed reply"),
      ];
      const session = createNativeStreamSession();
      startSlackStreamMock.mockResolvedValueOnce(session);
      appendSlackStreamMock.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
        session.pendingText = "failed reply";
        if (operation === "append") {
          session.stopped = true;
          throw error;
        }
        throw new TestSlackStreamNotDeliveredError(session.pendingText, "user_not_found");
      });
    }
    stopSlackStreamMock.mockRejectedValueOnce(error);
    const result = await dispatchWithReactions().catch((caught: unknown) => caught);
    expect({
      errorReactions: statusReactionControllerMock.setError.mock.calls.length,
      doneReactions: statusReactionControllerMock.setDone.mock.calls.length,
      outcome: result,
    }).toEqual({
      errorReactions: acknowledged ? 0 : 1,
      doneReactions: acknowledged ? 1 : 0,
      outcome: acknowledged ? undefined : error,
    });
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(operation === "append" ? 0 : 1);
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(acknowledged ? 1 : 3);
    if (acknowledged) {
      expectMockCallArgFields(startSlackStreamMock, 0, { text: FINAL_REPLY_TEXT, chunks: [] });
      expectSentHook(0, FINAL_REPLY_TEXT);
    } else {
      expect(postMessageMock).not.toHaveBeenCalled();
      expectSentHook(0, "already visible");
      expectSentHook(1, "second acknowledged");
      expectSentHook(2, "failed reply", { success: false, error: error.message });
    }
  },
);
it("normalizes only authored preview text when blocks own their fallback", async () => {
  useDraftStream(true);
  mockedDispatchSequence = [
    finalReply(
      presentation("**Summary**", [
        {
          type: "buttons",
          buttons: [{ label: "Owner <@U123>", action: { type: "callback", value: "owner" } }],
        },
      ]),
    ),
  ];

  await dispatch();

  expect(normalizeSlackOutboundTextMock).toHaveBeenCalledTimes(1);
  expect(normalizeSlackOutboundTextMock).toHaveBeenCalledWith("**Summary**", { tableMode: "code" });
  expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, { text: "**Summary**" });
});

it.each(["plain", "detailed"] as const)(
  "deduplicates a %s plan headline and preamble",
  async (format) => {
    const draftStream = useDraftStream();
    const plain = format === "plain";
    const headline = plain ? "Read *literal* <@U123>" : "Checking the workspace";
    const plan: SlackReplyOptionEvent = {
      ...planEvent("Inspect", headline),
      ...(plain ? { explanationFormat: "plain" as const } : {}),
    };
    const commentary = preamble(headline, "preamble-1");
    if (plain) {
      mockedDispatchSequence = [];
    }
    mockedReplyOptionEvents = plain ? [commentary, plan] : [plan, commentary];
    await dispatchProgress({
      style: "card",
      toolProgress: !plain,
      ...(!plain ? { commentary: true } : {}),
    });
    if (plain) {
      expect(draftStream.update).toHaveBeenLastCalledWith({
        text: "Read *literal* &lt;@U123&gt;",
        blocks: [section(headline, true)],
      });
    } else {
      const text = draftUpdateTexts(draftStream).at(-1)!;
      expect(text.match(/Checking the workspace/g)).toHaveLength(1);
      expect(text).toContain("_Checking the workspace_");
      expect(text).toContain("▸ Inspect");
    }
  },
);

it("caps the card fallback text at the draft limit while keeping the long blocks", async () => {
  const draftStream = useDraftStream();
  const long = (word: string) => Array.from({ length: 400 }, () => word).join(" ");
  mockedReplyOptionEvents = [
    planEvent("Inspect", long("explain")),
    preamble(long("status"), "preamble-1"),
    ...Array.from({ length: 20 }, (_, index) =>
      approval(`${long("run")}-${index}`, `approval-${index}`),
    ),
  ];
  await dispatchProgress({ style: "card" });
  const update = requireRecord(draftStream.update.mock.calls.at(-1)?.[0], "long card update");
  const blocks = update.blocks as unknown[];
  // Precondition: the full card text exceeds the 4,000-character draft limit.
  expect(buildSlackCompleteBlocksFallbackText(blocks).length).toBeGreaterThan(4000);
  expect((update.text as string).length).toBeLessThanOrEqual(4000);
  expect(JSON.stringify(blocks)).toContain("Approval required:");
});

it.each([
  { firstSend: "delivered", messageId: "171234.567" },
  // The first Slack post is still queued or in flight, so no message id exists yet.
  { firstSend: "pending", messageId: undefined },
])(
  "deletes a working card once a resolved approval was its last visible row (first send $firstSend)",
  async ({ messageId }) => {
    const draftStream = useDraftStream();
    draftStream.messageId = () => messageId;
    mockedReplyOptionEvents = [
      // The default card hides the plan, but the compositor still holds it.
      planEvent("Inspect"),
      approval("run checks"),
      { kind: "approval", phase: "resolved", approvalId: "approval-1" },
    ];
    await dispatchProgress({ style: "card" });
    expect(draftUpdateTexts(draftStream)).toEqual([
      "Approval required: run checks; approval requested",
    ]);
    expect(draftStream.clear).toHaveBeenCalled();
    expect(draftStream.forceNewMessage).toHaveBeenCalled();
  },
);
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
