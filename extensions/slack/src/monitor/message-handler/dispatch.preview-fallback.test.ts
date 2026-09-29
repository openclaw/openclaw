import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Slack tests cover dispatch.preview fallback plugin behavior.
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
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slackSetupPlugin } from "../../channel.setup.js";
import type { SlackSendResult } from "../../send.js";
import { getSlackSessionRuns } from "../session-run-targets.js";
import {
  emitCompactProgressScenario,
  type SlackReplyOptionEvent,
} from "./dispatch.compact-progress.test-support.js";
import type { PreparedSlackMessage } from "./types.js";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "thread-1";
const STREAM_MESSAGE_TS = "171234.567";
const SAME_TEXT = "same reply";

const getGlobalHookRunnerMock = vi.hoisted(() => vi.fn());
const createSlackDraftStreamMock = vi.fn();
type DeliveryParams = Omit<
  Parameters<typeof import("../replies.js").deliverReplies>[0],
  "replies"
> & {
  replies: ReplyPayload[];
};
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
const startSlackStreamMock = vi.fn(async (_input?: unknown) => ({
  channel: "C123",
  threadTs: THREAD_TS,
  stopped: false,
  delivered: true,
  pendingText: "",
}));
const stopSlackStreamMock = vi.fn(async (_params?: unknown) => ({}) as { messageId?: string });
const emitSlackMessageSentHooksMock = vi.fn(() => {});
const reactSlackMessageMock = vi.fn(async () => {});
const removeSlackReactionMock = vi.fn(async () => {});
const logVerboseMock = vi.fn();
class TestSlackStreamNotDeliveredError extends Error {
  readonly pendingText: string;
  readonly slackCode: string;
  constructor(pendingText: string, slackCode: string) {
    super(`slack-stream not delivered: ${slackCode}`);
    this.name = "SlackStreamNotDeliveredError";
    this.pendingText = pendingText;
    this.slackCode = slackCode;
  }
}
let mockedNativeStreaming = false;
let mockedBlockStreamingEnabled: boolean | undefined = false;
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
let capturedTyping:
  | {
      start: () => Promise<void>;
      stop?: () => Promise<void>;
      onStartError: (err: unknown) => void;
      onStopError?: (err: unknown) => void;
    }
  | undefined;
type TestReplyDispatchKind = "tool" | "block" | "final";
type TestReplyPayload = {
  text?: string;
  isError?: boolean;
  isReasoning?: boolean;
  mediaUrl?: string;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  spokenText?: string;
  ttsSupplement?: { spokenText: string; visibleTextAlreadyDelivered?: boolean };
  presentation?: { blocks: unknown[] };
};
type TestDispatchCounts = Record<TestReplyDispatchKind, number>;
type TestDispatchSequenceEntry =
  | {
      kind: TestReplyDispatchKind;
      payload: TestReplyPayload;
    }
  | { kind: "queued_followup" }
  | { kind: "item"; progressText: string };
let mockedDispatchSequence: TestDispatchSequenceEntry[] = [];
let mockedQueuedDispatchCounts: TestDispatchCounts = { tool: 0, block: 0, final: 0 };
let mockedAgentRunTerminalOutcome: "completed" | "failed" | undefined;
let mockedSourceReplyDelivered = false;
let mockedDispatchError: Error | undefined;
let useRealChannelInboundTurn = false;

let mockedProgressEvents: string[] = [];
let mockedReplyOptionEvents: SlackReplyOptionEvent[] = [];

function requireCapturedTyping() {
  if (!capturedTyping) {
    throw new Error("expected Slack typing callback");
  }
  return capturedTyping;
}

function createSlackPlatformError(error: string, details?: { needed?: string; provided?: string }) {
  // Mirrors @slack/web-api 7.18.0 platformErrorFromResult: message plus structured result data.
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error, ...details },
  });
}

function requireCapturedItemEventHandler() {
  const handler = capturedReplyOptions?.onItemEvent;
  if (!handler) {
    throw new Error("expected Slack reply item event handler");
  }
  return handler;
}

const requireRecord = createRequireRecord("object", "label-not-object");

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

function expectMockCallArgFields(mock: unknown, index: number, fields: Record<string, unknown>) {
  expectRecordFields(requireRecord(requireMockCall(mock, index, "call")[0], "params"), fields);
}

function expectNativeProgressStart(chunks: unknown[]) {
  expect(postMessageMock).not.toHaveBeenCalled();
  expect(chatUpdateMock).not.toHaveBeenCalled();
  expectMockCallArgFields(startSlackStreamMock, 0, {
    channel: "C123",
    threadTs: THREAD_TS,
    taskDisplayMode: "plan",
    chunks,
  });
}

function expectNativeProgressAppend(index: number, chunks: unknown[]) {
  expectMockCallArgFields(appendSlackStreamMock, index, {
    chunks,
  });
}

function expectNativeStreamText(text: string, count = 1) {
  const matches = [...startSlackStreamMock.mock.calls, ...appendSlackStreamMock.mock.calls].filter(
    (call) => {
      const params = requireRecord(call[0], "native stream text append");
      return params.text === text;
    },
  );
  expect(matches).toHaveLength(count);
}

function planUpdate(title: string) {
  return { type: "plan_update", title };
}

function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
  extra?: Record<string, unknown>,
) {
  return { type: "task_update", id, title, status, ...extra };
}

function contentTaskId(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix}_[a-f0-9]{8}_1$`, "u"));
}

function collectNativeTaskUpdates() {
  return [
    ...startSlackStreamMock.mock.calls,
    ...appendSlackStreamMock.mock.calls,
    ...stopSlackStreamMock.mock.calls,
  ]
    .flatMap(([value]) => {
      const arg = requireRecord(value, "native progress call");
      return Array.isArray(arg.chunks) ? arg.chunks : [];
    })
    .flatMap((chunk) => {
      const record = requireRecord(chunk, "native progress chunk");
      return record.type === "task_update" ? [record] : [];
    });
}

function expectDeliverReplyCall(index: number, text: string, fields?: Record<string, unknown>) {
  const params = requireRecord(
    requireMockCall(deliverRepliesMock, index, "deliver replies")[0],
    "deliver replies params",
  );
  expectRecordFields(params, { replyThreadTs: THREAD_TS, ...fields });
  expect(params.replies).toEqual([{ text }]);
}

function progressAccount(
  progress: Record<string, unknown> = { toolProgress: true, label: "Working" },
) {
  mockedSlackStreamingMode = "progress";
  return { streaming: { mode: "progress", progress } };
}

function preamble(progressText: string, itemId: string, phase?: string): SlackReplyOptionEvent {
  return { kind: "item", itemKind: "preamble", progressText, itemId, phase };
}

function checkpoint(run: () => Promise<void>): SlackReplyOptionEvent {
  return { kind: "checkpoint", run };
}

function delivered(index = 0) {
  return deliverRepliesMock.mock.calls[index]![0];
}

function ttsPayload(spokenText = "Spoken answer", visibleTextAlreadyDelivered?: boolean) {
  return {
    mediaUrl: "https://example.com/tts.mp3",
    audioAsVoice: true,
    spokenText,
    ttsSupplement: {
      spokenText,
      ...(visibleTextAlreadyDelivered ? { visibleTextAlreadyDelivered: true } : {}),
    },
  };
}

const noop = () => {};
const noopAsync = async () => {};
function createNativeStreamSession() {
  return {
    channel: "C123",
    threadTs: THREAD_TS,
    stopped: false,
    delivered: true,
    pendingText: "",
  };
}

function createDraftStreamStub() {
  return {
    update: vi.fn(),
    flush: vi.fn(noopAsync),
    clear: vi.fn(noopAsync),
    discardPending: vi.fn(noopAsync),
    seal: vi.fn(noopAsync),
    stop: vi.fn(noop),
    forceNewMessage: vi.fn(),
    dropDetachedMessages: vi.fn(noopAsync),
    finalizeMessage: vi.fn(async (_messageId: string, editFinal: () => Promise<void>) => {
      await editFinal();
      return true;
    }),
    messageId: (): string | undefined => "171234.567",
    channelId: () => "C123",
  };
}

function useDraftStream() {
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
  setSlackSessionStatus?: PreparedSlackMessage["ctx"]["setSlackSessionStatus"];
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
      setSlackSessionStatus: params?.setSlackSessionStatus ?? (async () => true),
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

async function dispatchNativeProgressScenario(params: {
  events: typeof mockedReplyOptionEvents;
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
      typing?: {
        start: () => Promise<void>;
        stop?: () => Promise<void>;
        onStartError: (err: unknown) => void;
        onStopError?: (err: unknown) => void;
      };
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
    resolveChannelStreamingBlockEnabled: () => mockedBlockStreamingEnabled,
  };
});

vi.mock("openclaw/plugin-sdk/reply-payload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-payload")>()),
  resolveAskUserQuestionOptionIndices: () => undefined,
  isReplyPayloadNonTerminalToolErrorWarning: () => false,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
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

vi.mock("../../actions.js", () => ({
  reactSlackMessage: reactSlackMessageMock,
  removeSlackReaction: removeSlackReactionMock,
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: createSlackDraftStreamMock,
}));

vi.mock("../../format.js", () => ({
  markdownToSlackMrkdwnChunks: (value: string) => [value],
  normalizeSlackOutboundText: normalizeSlackOutboundTextMock,
}));

vi.mock("../../limits.js", () => ({
  SLACK_TEXT_LIMIT: 4000,
  SLACK_EDIT_TEXT_MAX_BYTES: 4000,
}));

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
      if (mockedReplyOptionEvents.length > 0) {
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
          } else if (entry.kind === "checkpoint") {
            await entry.run();
          } else if (entry.kind === "approval") {
            const { kind: _kind, ...payload } = entry;
            await params.replyOptions?.onApprovalEvent?.(payload);
          } else {
            await params.replyOptions?.onPartialReply?.({ text: entry.text });
          }
        }
      } else {
        for (const progressText of mockedProgressEvents) {
          await params.replyOptions?.onItemEvent?.({ progressText });
        }
      }
      if (mockedDispatchError) {
        throw mockedDispatchError;
      }
      for (const entry of mockedDispatchSequence) {
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

describe("dispatchPreparedSlackMessage preview fallback", () => {
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
    mockedBlockStreamingEnabled = false;
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
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedQueuedDispatchCounts = { tool: 0, block: 0, final: 0 };
    mockedAgentRunTerminalOutcome = undefined;
    mockedSourceReplyDelivered = false;
    mockedDispatchError = undefined;
    mockedProgressEvents = [];
    mockedReplyOptionEvents = [];

    createSlackDraftStreamMock.mockReturnValue(createDraftStreamStub());
    finalizeSlackPreviewEditMock.mockRejectedValue(new Error("socket closed"));
    startSlackStreamMock.mockResolvedValue(createNativeStreamSession());
    appendSlackStreamMock.mockResolvedValue(undefined);
    stopSlackStreamMock.mockResolvedValue({});
    emitSlackMessageSentHooksMock.mockClear();
  });

  afterEach(() => resetPluginRuntimeStateForTest());

  it.each([
    { agents: ["alice", "bob"], withMedia: true },
    { agents: ["alice", "bob"], withMedia: false },
  ])(
    "binds group-thread completion hooks and media to the participant: $agents (media: $withMedia)",
    async ({ agents, withMedia }) => {
      useRealChannelInboundTurn = true;
      mockedNativeStreaming = true;
      const { resolveGroupThreadMentionFacts } =
        await import("openclaw/plugin-sdk/channel-inbound");
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
        actualReplies.deliverReplies({ ...params, replies: params.replies.map(prepareSlackReply) }),
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
      expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(agents.length);
      expect(sendMessageSlackMock).toHaveBeenCalledTimes(agents.length);
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
      expect(startSlackStreamMock).not.toHaveBeenCalled();
      expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "delivers literal authored fallback normally with native streaming %s",
    async (nativeStreaming) => {
      mockedNativeStreaming = nativeStreaming;
      finalizeSlackPreviewEditMock.mockResolvedValue(undefined);
      const payload = {
        text: "Run /inspect *literal* <!channel>, then check the report.",
        presentationTextMode: "fallback" as const,
        presentation: {
          blocks: [
            {
              type: "buttons" as const,
              buttons: [
                { label: "Inspect", action: { type: "command" as const, command: "/inspect" } },
              ],
            },
          ],
        },
      };
      mockedDispatchSequence = [{ kind: "final", payload }];

      await dispatch();

      expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
      expect(startSlackStreamMock).not.toHaveBeenCalled();
      expect(appendSlackStreamMock).not.toHaveBeenCalled();
      expect(deliverRepliesMock).toHaveBeenCalledWith(
        expect.objectContaining({ replies: [payload] }),
      );
    },
  );

  it("preserves rejected queue admission without retaining a publisher", async () => {
    const onSettled = vi.fn();
    const prepared: Parameters<typeof dispatchPreparedSlackMessage>[0] = createPreparedSlackMessage(
      {
        turnAdoptionLifecycle: {
          admission: "exclusive",
          onAdopted: async () => {},
          onDeferred: () => false,
          onSettled,
        },
      },
    );
    await dispatchPreparedSlackMessage(prepared);
    expect(capturedReplyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(false);
    expect(getSlackSessionRuns(prepared.ctx, { channelId: "C123", threadTs: THREAD_TS })).toEqual(
      [],
    );
    capturedReplyOptions?.turnAdoptionLifecycle?.onSettled?.();
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
    const prepared: Parameters<typeof dispatchPreparedSlackMessage>[0] = createPreparedSlackMessage(
      { message, replyToMode: "first" },
    );
    mockedReplyOptionEvents = [
      checkpoint(async () => {
        expect(
          getSlackSessionRuns(prepared.ctx, {
            channelId: message.channel,
            threadTs: message.ts,
          }).map(({ route }) => route.sessionKey),
        ).toEqual([prepared.route.sessionKey]);
      }),
    ];
    await dispatchPreparedSlackMessage(prepared);
  });

  it("retains queued publisher ownership until settlement", async () => {
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
    const endQueuedRun = capturedReplyOptions?.queuedDeliveryCorrelations?.[0]?.begin();
    capturedReplyOptions?.turnAdoptionLifecycle?.onSettled?.();
    expect(getSlackSessionRuns(prepared.ctx, address)).toHaveLength(1);
    expect(getSlackSessionRuns({ ...prepared.ctx }, address)).toHaveLength(1);
    const restarted: Parameters<typeof dispatchPreparedSlackMessage>[0] =
      createPreparedSlackMessage();
    expect(getSlackSessionRuns(restarted.ctx, address)).toEqual([]);
    endQueuedRun?.();
    expect(getSlackSessionRuns(prepared.ctx, address)).toEqual([]);
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses portable provider previews when %s is registered",
    async (modifyingHook) => {
      getGlobalHookRunnerMock.mockReturnValue({
        hasHooks: vi.fn((hookName: string) => hookName === modifyingHook),
      });

      await dispatch();

      expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
      expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
      expect(deliverRepliesMock).toHaveBeenCalledOnce();
      expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
    },
  );

  it("suppresses native progress cards when a modifying hook is registered", async () => {
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "message_sending"),
    });

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [{ kind: "item", progressText: "private progress" }],
    });

    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expect(startSlackStreamMock).not.toHaveBeenCalled();
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("preserves post-hook native answer streaming when a modifying hook is registered", async () => {
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "reply_payload_sending"),
    });
    mockedNativeStreaming = true;

    await dispatch();

    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
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

  it("uses a disposable portable preview before custom-identity final delivery", async () => {
    const relayIdentity = { username: "Nik Team Claw", iconEmoji: ":robot_face:" };
    const draftStream = {
      ...createDraftStreamStub(),
      clear: vi.fn(noopAsync),
      discardPending: vi.fn(noopAsync),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);

    await dispatch({ relayIdentity });

    expect(createSlackDraftStreamMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ identity: expect.anything() }),
    );
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { identity: relayIdentity });
  });

  it("uses supported native Slack streaming authorship when a custom identity is active", async () => {
    mockedNativeStreaming = true;
    const relayIdentity = { username: "Nik Team Claw" };

    await dispatch({ relayIdentity });

    expectMockCallArgFields(startSlackStreamMock, 0, {
      text: FINAL_REPLY_TEXT,
      identity: relayIdentity,
    });
    expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it("does not create a Slack thread for top-level messages when replyToMode is off", async () => {
    mockedSlackStreamingMode = "off";
    mockedSlackIsThreadReply = false;

    await dispatch({ replyToMode: "off" });

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT, { replyThreadTs: undefined });
  });

  it("updates non-main DM last-route metadata on the prepared direct session", async () => {
    mockedPinnedMainDmOwner = "U2";
    await dispatch({
      cfg: { session: { dmScope: "per-channel-peer" } },
      isDirectMessage: true,
      message: {
        channel: "D123",
        user: "U1",
        ts: "501.000",
        thread_ts: "500.000",
      },
      route: {
        agentId: "main",
        mainSessionKey: "agent:main:main",
        sessionKey: "agent:main:slack:direct:u1",
        lastRoutePolicy: "session",
      },
      ctxPayload: {
        MessageThreadId: "500.000",
        SessionKey: "agent:main:slack:direct:u1",
      },
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-store.json",
      sessionKey: "agent:main:slack:direct:u1",
      deliveryContext: {
        channel: "slack",
        to: "user:U1",
        accountId: "default",
        threadId: "500.000",
      },
      ctx: {
        MessageThreadId: "500.000",
        SessionKey: "agent:main:slack:direct:u1",
      },
    });
  });

  it("preserves a workspace-qualified DM route during dispatch", async () => {
    await dispatch({
      isDirectMessage: true,
      message: {
        channel: "D123",
        user: "U1",
        ts: "501.000",
      },
      ctxPayload: {
        OriginatingTo: "team:T123:user:U1",
        SessionKey: "agent:main:main:account:default:team:t123",
      },
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: expect.objectContaining({ to: "team:T123:user:U1" }),
      }),
    );
  });

  it("uses DM transport thread metadata for last-route updates", async () => {
    await dispatch({
      isDirectMessage: true,
      message: {
        channel: "D123",
        user: "U1",
        ts: "701.000",
        thread_ts: "701.000",
      },
      route: {
        agentId: "main",
        mainSessionKey: "agent:main:main",
        sessionKey: "agent:main:main",
        lastRoutePolicy: "main",
      },
      ctxPayload: {
        MessageThreadId: undefined,
        ReplyToId: "701.000",
        TransportThreadId: "701.000",
        SessionKey: "agent:main:main",
      },
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith({
      storePath: "/tmp/openclaw-store.json",
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "slack",
        to: "user:U1",
        accountId: "default",
        threadId: "701.000",
      },
      ctx: {
        ReplyToId: "701.000",
        TransportThreadId: "701.000",
        SessionKey: "agent:main:main",
      },
    });
  });

  it.each([
    ["code", "```\n| Name | Value |\n| ---- | ----- |\n| Beta | 2     |\n```"],
    ["bullets", "*Beta*\n• Value: 2"],
    ["off", "| Name | Value |\n| --- | --- |\n| Beta | 2 |"],
  ] as const)(
    "preserves %s table mode when finalizing authored preview text",
    async (tables, expected) => {
      const { normalizeSlackOutboundText } =
        await vi.importActual<typeof import("../../format.js")>("../../format.js");
      normalizeSlackOutboundTextMock.mockImplementation(normalizeSlackOutboundText);
      try {
        finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
        mockedDispatchSequence = [
          { kind: "final", payload: { text: "| Name | Value |\n| --- | --- |\n| Beta | 2 |" } },
        ];

        await dispatch({
          cfg: { channels: { slack: { markdown: { tables } } } },
        });

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

  it("keeps distinct split table fallbacks distinct in delivery tracking", async () => {
    mockedSlackStreamingMode = "off";
    const buildPayload = (owner: string) => ({
      text: "Accounts",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Account owners",
            headers: ["Owner"],
            rows: Array.from({ length: 100 }, () => [`${owner}-${"x".repeat(110)}`]),
          },
        ],
      },
    });
    const firstPayload = buildPayload("Ada");
    const secondPayload = buildPayload("Grace");
    mockedDispatchSequence = [
      { kind: "final", payload: firstPayload },
      { kind: "final", payload: secondPayload },
    ];

    await dispatch();

    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    const firstDelivery = delivered(0);
    const secondDelivery = delivered(1);
    expect(firstDelivery.replies).toEqual([firstPayload]);
    expect(secondDelivery.replies).toEqual([secondPayload]);
  });

  it("logs the formatted Slack error when adding the typing reaction fails", async () => {
    reactSlackMessageMock.mockRejectedValueOnce(
      createSlackPlatformError("missing_scope", {
        needed: "reactions:write",
        provided: "chat:write",
      }),
    );

    await dispatch({ typingReaction: "hourglass_flowing_sand" });
    await expect(requireCapturedTyping().start()).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      "slack send: typing reaction failed: An API error occurred: missing_scope; code: slack_webapi_platform_error; slack error: missing_scope; needed: reactions:write; provided: chat:write",
    );
  });

  it("logs the formatted Slack error when removing the typing reaction fails", async () => {
    removeSlackReactionMock.mockRejectedValueOnce(createSlackPlatformError("invalid_auth"));

    await dispatch({ typingReaction: "hourglass_flowing_sand" });
    const typing = requireCapturedTyping();
    await typing.start();
    await expect(typing.stop?.()).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      "slack send: typing reaction removal failed: An API error occurred: invalid_auth; code: slack_webapi_platform_error; slack error: invalid_auth",
    );
  });

  it("keeps Slack status reactions when channel replies are message-tool-only", async () => {
    await dispatch({
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
          statusReactions: { enabled: true },
        },
      },
      ctxPayload: { ChatType: "channel" },
      ackReactionMessageTs: "171234.111",
      ackReactionPromise: Promise.resolve(true),
    });

    expect(capturedReplyOptions?.disableBlockStreaming).toBe(true);
    expect(capturedReplyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    expect(capturedReplyOptions?.allowToolLifecycleWhenProgressHidden).toBe(true);
    expectRecordFields(requireRecord(capturedStatusReactionOptions, "status reaction options"), {
      enabled: true,
      initialEmoji: "eyes",
    });
    expect(statusReactionControllerMock.setQueued).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setDone).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setDone.mock.invocationCallOrder[0]).toBeLessThan(
      statusReactionControllerMock.restoreInitial.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("marks a recovered agent failure as failed then restores its initial reaction", async () => {
    mockedAgentRunTerminalOutcome = "failed";
    mockedNativeStreaming = true;

    mockedReplyOptionEvents = [{ kind: "item", progressText: "Recovering failed run" }];
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "Something failed", isError: true } },
    ];

    await dispatch({
      cfg: { messages: { statusReactions: { enabled: true } } },
      accountConfig: progressAccount({ toolProgress: true, nativeTaskCards: true }),
      ackReactionMessageTs: "171234.111",
      ackReactionPromise: Promise.resolve(true),
    });

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(startSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(1);
    expect(collectNativeTaskUpdates().at(-1)).toEqual(expect.objectContaining({ status: "error" }));
    expect(statusReactionControllerMock.setError).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
    expect(statusReactionControllerMock.setError.mock.invocationCallOrder[0]).toBeLessThan(
      statusReactionControllerMock.restoreInitial.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps Slack lifecycle reactions off for ambient room-event acks", async () => {
    await dispatch({
      cfg: { messages: { statusReactions: { enabled: true } } },
      ctxPayload: { ChatType: "channel", InboundEventKind: "room_event" },
      ackReactionMessageTs: "171234.111",
      ackReactionPromise: Promise.resolve(true),
    });

    expectRecordFields(requireRecord(capturedStatusReactionOptions, "status reaction options"), {
      enabled: false,
      initialEmoji: "eyes",
    });
    expect(statusReactionControllerMock.setQueued).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
  });

  it("escapes Slack mrkdwn in tool progress preview labels", async () => {
    const draftStream = useDraftStream();
    mockedDispatchSequence = [];
    mockedProgressEvents = ["ran <!here> <@U123> *bold* `code` & done"];

    await dispatch({
      accountConfig: { streaming: { progress: { toolProgress: true, label: "Shelling" } } },
    });

    expect(draftUpdateTexts(draftStream)).toContain(
      "Shelling\n\n• ran &lt;!here&gt; &lt;@U123&gt; *bold* `code` &amp; done",
    );
  });

  it("renders and finalizes one Slack session card while delivering final text separately", async () => {
    const draftStream = useDraftStream();
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "partial", text: "partial answer" },
      { kind: "item", progressText: "tool two" },
    ];

    await dispatch({
      cfg: {
        gateway: {
          publicOrigin: "https://team.openclaw.ai",
          controlUi: { basePath: "/openclaw" },
        },
      },
      accountConfig: { streaming: { progress: { toolProgress: true, label: "Shelling" } } },
    });

    expect(draftStream.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: ["Shelling", "", "• tool one", "• tool two"].join("\n"),
        blocks: expect.arrayContaining([
          { type: "section", text: { type: "mrkdwn", text: "🔄 *Shelling*" } },
        ]),
      }),
    );
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, {
      channelId: "C123",
      messageId: "171234.567",
    });
    const finalEdit = requireRecord(
      requireMockCall(finalizeSlackPreviewEditMock, 0, "session card final edit")[0],
      "session card final edit",
    );
    expect(JSON.stringify(finalEdit.blocks)).toContain("✅ *Shelling*");
    expect(JSON.stringify(finalEdit.blocks)).toContain("Open in OpenClaw");
    expect(JSON.stringify(finalEdit.blocks)).toContain(
      "https://team.openclaw.ai/openclaw/chat/agent-1/slack/C123",
    );
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("clears the stale session card when the terminal edit fails after final delivery", async () => {
    const draftStream = useDraftStream();
    // Final reply lands, but terminalizing the card into its ✅ state fails.
    finalizeSlackPreviewEditMock.mockRejectedValueOnce(new Error("card edit failed"));

    mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];

    await dispatch({
      accountConfig: progressAccount(),
    });

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
    // A card left in its Working state would misrepresent a finished turn; the
    // failed terminalization must drop it instead of leaving it stranded.
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("terminalizes the progress card on a dispatch error", async () => {
    const draftStream = useDraftStream();

    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];
    mockedDispatchError = new Error("agent dispatch failed");

    await expect(
      dispatch({
        accountConfig: progressAccount(),
      }),
    ).rejects.toThrow("agent dispatch failed");

    const finalEdit = requireRecord(
      requireMockCall(finalizeSlackPreviewEditMock, 0, "dispatch error card edit")[0],
      "dispatch error card edit",
    );
    expect(JSON.stringify(finalEdit.blocks)).toContain("❌ *Working*");
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps a failed no-reply card but deletes a silent successful card", async () => {
    const failedDraft = createDraftStreamStub();
    const silentDraft = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(failedDraft).mockReturnValueOnce(silentDraft);
    finalizeSlackPreviewEditMock.mockResolvedValue(undefined);

    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];
    mockedAgentRunTerminalOutcome = "failed";

    await dispatch({
      accountConfig: progressAccount(),
    });
    expect(failedDraft.clear).not.toHaveBeenCalled();
    expect(JSON.stringify(finalizeSlackPreviewEditMock.mock.calls[0]?.[0]?.blocks)).toContain(
      "❌ *Working*",
    );

    finalizeSlackPreviewEditMock.mockClear();
    mockedAgentRunTerminalOutcome = "completed";
    await dispatch({
      accountConfig: progressAccount(),
    });
    expect(silentDraft.clear).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
  });

  it("batches native milestone updates and prevents pending updates after final delivery", async () => {
    vi.useFakeTimers();
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        {
          kind: "plan",
          phase: "update",
          explanation: "Checking the workspace",
          steps: [{ step: "Inspect", status: "in_progress" }],
        },
        {
          kind: "plan",
          phase: "update",
          explanation: "Checking the workspace",
          steps: [{ step: "Intermediate", status: "in_progress" }],
        },
        {
          kind: "plan",
          phase: "update",
          explanation: "Checking the workspace",
          steps: [{ step: "Run tests", status: "in_progress" }],
        },
        checkpoint(async () => {
          expect(startSlackStreamMock).toHaveBeenCalledOnce();
          expect(appendSlackStreamMock).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(999);
          expect(appendSlackStreamMock).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          expectNativeProgressAppend(0, [taskUpdate("plan_step_1", "Run tests", "in_progress")]);
        }),
        {
          kind: "plan",
          phase: "update",
          explanation: "Checking the workspace",
          steps: [{ step: "Final checks", status: "in_progress" }],
        },
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
        { kind: "tool_start", phase: "start", name: "bash" },
        { kind: "approval", phase: "requested", approvalId: "approval-1", command: "run checks" },
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

  it.each([
    { toolProgress: false, isError: false },
    { toolProgress: false, isError: true },
  ])(
    "keeps intermediate command failures out of quiet native streams (tools=$toolProgress, error=$isError)",
    async ({ toolProgress, isError }) => {
      await dispatchNativeProgressScenario({
        finalPayload: { text: FINAL_REPLY_TEXT, ...(isError ? { isError: true } : {}) },
        progress: { style: "card", toolProgress, nativeTaskCards: true },
        events: [
          {
            kind: "plan",
            phase: "update",
            explanation: "Checking the workspace",
            steps: [{ step: "Run checks", status: "in_progress" }],
          },
          { kind: "command_output", phase: "end", name: "Bash", title: "run checks", exitCode: 1 },
          {
            kind: "command_output",
            phase: "end",
            name: "Bash",
            title: "retry checks",
            exitCode: 8,
          },
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
        taskUpdate("plan_step_1", "Run checks", isError ? "error" : "complete"),
      ]);
      if (isError) {
        expect(deliverRepliesMock).toHaveBeenCalledWith(
          expect.objectContaining({ replies: [{ text: FINAL_REPLY_TEXT, isError: true }] }),
        );
      } else {
        expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
      }
    },
  );

  it("keeps the final inside a native stream that is still buffered locally", async () => {
    // A short narration leaves the SDK session un-flushed (`delivered` false);
    // `stop` is then its first network call. Delivering the final normally here
    // would post one message and finalize the stream into a second one.
    startSlackStreamMock.mockResolvedValue({
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: "",
    });

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [{ kind: "item", progressText: "slow tool" }],
    });

    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  });

  it.each([true, false])(
    "settles a rejected append when native stop succeeds: %s",
    async (nativeStopSucceeds) => {
      mockedNativeStreaming = true;
      mockedDispatchSequence = [
        { kind: "final", payload: { text: "already visible" } },
        { kind: "final", payload: { text: "rejected reply" } },
      ];
      const session = createNativeStreamSession();
      const rejection = new TestSlackStreamNotDeliveredError("rejected reply", "user_not_found");
      const sendError = new Error("fallback send failed");
      startSlackStreamMock.mockResolvedValueOnce(session);
      appendSlackStreamMock.mockImplementationOnce(async () => {
        session.pendingText = "rejected reply";
        throw rejection;
      });
      if (nativeStopSucceeds) {
        stopSlackStreamMock.mockImplementationOnce(async () => {
          session.pendingText = "";
          return { messageId: STREAM_MESSAGE_TS };
        });
      } else {
        stopSlackStreamMock.mockRejectedValueOnce(rejection);
        deliverRepliesMock.mockRejectedValueOnce(sendError);
      }

      const result = await dispatch().catch((error: unknown) => error);

      expect(result).toBe(nativeStopSucceeds ? undefined : sendError);
      expect(deliverRepliesMock).toHaveBeenCalledTimes(nativeStopSucceeds ? 0 : 1);
      expect(stopSlackStreamMock).toHaveBeenCalledOnce();
      expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
      expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, {
        content: "already visible",
        success: true,
        messageId: STREAM_MESSAGE_TS,
      });
      expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, {
        content: "rejected reply",
        success: nativeStopSucceeds,
        ...(nativeStopSucceeds ? { messageId: STREAM_MESSAGE_TS } : { error: sendError.message }),
      });
    },
  );

  it.each<{
    name: string;
    events: typeof mockedReplyOptionEvents;
    updates: Parameters<typeof expectNativeProgressStart>[0];
  }>([
    {
      name: "starts native Slack progress from typed plan steps",
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
      name: "deduplicates a native title shared by a fresh preamble and a prepared note",
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
        taskUpdate(expect.any(String), "Update Plan", "in_progress", {
          details: "Checking results",
        }),
      ],
    },
  ])("$name", async ({ events, updates }) => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events,
    });
    expectNativeProgressStart(updates);
  });

  it("starts native Slack progress from a retained headline when tool rows are hidden", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      progress: { style: "card", label: false, nativeTaskCards: true, toolProgress: false },
      events: [
        preamble("Checking the workspace", "preamble-1"),
        {
          kind: "tool_start",
          itemId: "tool-1",
          name: "bash",
          phase: "start",
          args: { command: "pnpm test" },
        },
      ],
    });

    expectNativeProgressStart([
      planUpdate("Checking the workspace"),
      taskUpdate("openclaw_summary", "Checking the workspace", "in_progress"),
    ]);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  });

  it("streams rolling reasoning snapshots as deduplicated narration", async () => {
    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
      events: [
        { kind: "reasoning", text: "Checking", isReasoningSnapshot: true },
        {
          kind: "reasoning",
          text: "Checking the Slack handler",
          isReasoningSnapshot: true,
        },
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
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it.each([
    { name: "oversized", payload: { text: "x".repeat(4001) } },
    {
      name: "media-bearing",
      payload: { text: FINAL_REPLY_TEXT, mediaUrls: ["https://example.com/result.png"] },
    },
  ])("delivers $name native progress finals through the normal sender", async ({ payload }) => {
    await dispatchNativeProgressScenario({
      finalPayload: payload,
      events: [{ kind: "item", progressText: "slow tool" }],
    });

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const delivery = delivered(0);
    expect(delivery.replies).toEqual([payload]);
    expectNativeStreamText(`\n${payload.text}`, 0);
  });

  it("retries identical native progress after Slack buffers the first update", async () => {
    const session = {
      channel: "C123",
      threadTs: THREAD_TS,
      stopped: false,
      delivered: false,
      pendingText: "",
    };
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.delivered = true;
    });

    await dispatchNativeProgressScenario({
      events: [
        { kind: "item", itemId: "item-1", progressText: "still working" },
        { kind: "item", itemId: "item-1", progressText: "still working" },
      ],
    });

    expect(startSlackStreamMock).toHaveBeenCalledOnce();
    expect(appendSlackStreamMock).toHaveBeenCalledOnce();
    expect(session.delivered).toBe(true);
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
      { kind: "final", payload: { text: "same answer" } },
      { kind: "queued_followup" },
      { kind: "item", progressText: "queued tool" },
      { kind: "final", payload: { text: "same answer" } },
    ];

    await dispatch({
      accountConfig: progressAccount({ toolProgress: true, nativeTaskCards: true }),
    });

    expect(startSlackStreamMock).toHaveBeenCalledTimes(2);
    expect(stopSlackStreamMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expectNativeStreamText("\nsame answer", 2);
    expectMockCallArgFields(stopSlackStreamMock, 0, {
      session: firstSession,
    });
    expectMockCallArgFields(stopSlackStreamMock, 1, {
      session: secondSession,
    });
    expect(stopSlackStreamMock.mock.invocationCallOrder[0]).toBeLessThan(
      startSlackStreamMock.mock.invocationCallOrder[1] ?? 0,
    );
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
    expect(appendSlackStreamMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expectMockCallArgFields(stopSlackStreamMock, 0, {
      chunks: [
        taskUpdate(contentTaskId("item"), "tool one", "complete"),
        taskUpdate(contentTaskId("item"), "tool two", "complete"),
        taskUpdate(contentTaskId("item"), "tool three", "complete"),
      ],
    });
  });

  it("passes configured native progress max line chars into stream chunks", async () => {
    const taskId = expect.stringMatching(/^exec_call_1_[a-f0-9]{8}$/);

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
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
    });

    expectNativeProgressStart([
      planUpdate("Shelling"),
      taskUpdate(taskId, "Bash", "in_progress", { details: "12345…uvwxyz" }),
    ]);
    // Slack appends `details` per task_update; the unchanged command is not resent.
    expectNativeProgressAppend(0, [taskUpdate(taskId, "Bash", "complete")]);
  });

  it("re-arms an isolated progress draft on an assistant boundary after final delivery", async () => {
    const draftStream = useDraftStream();
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);

    mockedReplyOptionEvents = [{ kind: "item", progressText: "first turn" }];

    await dispatch({
      accountConfig: progressAccount(),
    });
    await capturedReplyOptions?.onAssistantMessageStart?.();
    await requireCapturedItemEventHandler()({ progressText: "second turn" });

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      draftStream.forceNewMessage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expectLastDraftUpdateText(draftStream, "Working\n\n• second turn");
  });

  it("clears re-armed queued progress when the followup settles without a final delivery", async () => {
    const draftStream = useDraftStream();

    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [{ kind: "item", progressText: "silent turn" }];

    await dispatch({
      accountConfig: progressAccount(),
    });
    await capturedReplyOptions?.onQueuedFollowupAdmitted?.();
    await requireCapturedItemEventHandler()({ progressText: "queued turn" });
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const clearCallsBeforeSettlement = draftStream.clear.mock.calls.length;
    const dropCallsBeforeSettlement = draftStream.dropDetachedMessages.mock.calls.length;
    await capturedReplyOptions?.onQueuedFollowupSettled?.();

    expectLastDraftUpdateText(draftStream, "Working\n\n• queued turn");
    expect(draftStream.clear).toHaveBeenCalledTimes(clearCallsBeforeSettlement + 1);
    expect(draftStream.clear.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      draftStream.update.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
    expect(draftStream.dropDetachedMessages).toHaveBeenCalledTimes(dropCallsBeforeSettlement + 1);
    expect(draftStream.dropDetachedMessages.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      draftStream.clear.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
  });

  it("clears a queued quiet preamble after its original dispatch has returned", async () => {
    const draftStream = createDraftStreamStub();
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);

    mockedDispatchSequence = [];

    await dispatch({
      accountConfig: progressAccount({
        label: false,
        commentary: true,
        toolProgress: false,
        maxLines: 1,
      }),
    });
    await capturedReplyOptions?.onQueuedFollowupAdmitted?.();
    await requireCapturedItemEventHandler()({
      kind: "preamble",
      itemId: "queued-preamble",
      progressText: "Checking the followup",
    });
    expectLastDraftUpdateText(draftStream, "_Checking the followup_");
    const clearCallsBeforeSettlement = draftStream.clear.mock.calls.length;

    await capturedReplyOptions?.onQueuedFollowupSettled?.();

    expect(draftStream.clear).toHaveBeenCalledTimes(clearCallsBeforeSettlement + 1);
    expect(draftStream.clear.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      draftStream.update.mock.invocationCallOrder.at(-1) ?? Number.POSITIVE_INFINITY,
    );
    // Settlement removes temporary presentation; it must not create another reply.
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it.each([
    { humanReply: false, messageToolReply: false, delayedReceipt: false, silent: false },
    { humanReply: true, messageToolReply: false, delayedReceipt: false, silent: false },
    { humanReply: true, messageToolReply: true, delayedReceipt: true, silent: false },
    { humanReply: true, messageToolReply: false, delayedReceipt: false, silent: true },
  ])(
    "settles interrupted previews without losing human context (human=$humanReply, message tool=$messageToolReply, delayed receipt=$delayedReceipt, silent=$silent)",
    async ({ humanReply, messageToolReply, delayedReceipt, silent }) => {
      mockedSlackStreamingMode = "partial";
      mockedDispatchSequence =
        messageToolReply || silent ? [] : [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
      mockedSourceReplyDelivered = messageToolReply;
      const { createSlackDraftStream } =
        await vi.importActual<typeof import("../../draft-stream.js")>("../../draft-stream.js");
      const { noteSlackDraftConversationMessage } =
        await import("../../draft-message-boundaries.js");
      const visibleMessages = new Map<string, string>();
      let nextMessageId = 100;
      let draftStream: ReturnType<typeof createSlackDraftStream> | undefined;
      let noteHumanReply = () => {};
      let releaseReceipt!: () => void;
      const receipt = new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      let closeoutStarted = false;
      let pendingFlush: Promise<void> | undefined;
      createSlackDraftStreamMock.mockImplementationOnce(
        (params: Parameters<typeof createSlackDraftStream>[0]) => {
          draftStream = createSlackDraftStream({
            ...params,
            send: async (_target, text) => {
              const messageId = String(nextMessageId++);
              visibleMessages.set(messageId, text);
              if (delayedReceipt) {
                await receipt;
              }
              return {
                channelId: "C123",
                messageId,
                receipt: createMessageReceiptFromOutboundResults({
                  results: [{ channel: "slack", channelId: "C123", messageId }],
                  kind: "preview",
                }),
              };
            },
            edit: async (_channelId, messageId, text) => {
              visibleMessages.set(messageId, text);
            },
            remove: async (_channelId, messageId) => {
              visibleMessages.delete(messageId);
            },
          });
          const discardPending = draftStream.discardPending;
          draftStream.discardPending = () => {
            closeoutStarted = true;
            return discardPending();
          };
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
          pendingFlush = draftStream?.flush();
          if (delayedReceipt) {
            await vi.waitFor(() => expect(visibleMessages.size).toBe(1));
          } else {
            await pendingFlush;
          }
          expect([...visibleMessages.values()]).toEqual(["I will inspect the files."]);
          if (humanReply && !delayedReceipt) {
            noteHumanReply();
          }
          if (messageToolReply) {
            visibleMessages.set("message-tool-reply", FINAL_REPLY_TEXT);
          }
        }),
        { kind: "assistant_start" },
        ...(messageToolReply || silent
          ? []
          : [{ kind: "partial" as const, text: FINAL_REPLY_TEXT }]),
      ];

      const dispatching = dispatch();
      if (delayedReceipt) {
        await vi.waitFor(() => expect(closeoutStarted).toBe(true));
        if (humanReply) {
          noteHumanReply();
        }
        releaseReceipt();
      }
      await dispatching;
      await pendingFlush;
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
        expectLastDraftUpdateText(draftStream, "_I will check the result._");
        expect(draftUpdateTexts(draftStream)).toEqual(["_I will check the result._"]);
        expect(draftStream.update.mock.calls.at(-1)?.[0]).toMatchObject({
          allowNewMessage: true,
        });
      }),
      preamble("The result is ready.", "p2", "end"),
    ];

    await dispatch({
      accountConfig: progressAccount({
        label: false,
        commentary: true,
        toolProgress: false,
        maxLines: 1,
      }),
    });

    // Assert the intermediate observations ran; the final text alone cannot
    // prove that Slack never received a first-token notification.
    expect(checkpoints).toHaveBeenCalledTimes(4);
    expectLastDraftUpdateText(draftStream, "_The result is ready._");
    expect(draftStream.update.mock.calls.at(-1)?.[0]).toMatchObject({
      allowNewMessage: true,
    });
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("keeps only the latest Slack commentary when tool progress is disabled", async () => {
    const draftStream = useDraftStream();

    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      preamble("Checking the Slack event path", "preamble-1"),
      preamble("Preparing the smallest fix", "preamble-2"),
    ];

    await dispatch({
      accountConfig: progressAccount({
        label: false,
        commentary: true,
        toolProgress: false,
        maxLines: 1,
      }),
    });

    expect(capturedReplyOptions?.commentaryProgressEnabled).toBe(true);
    expect(capturedReplyOptions?.commentaryPayloadsEnabled).toBe(true);
    expect(capturedReplyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(false);
    expect(capturedReplyOptions?.suppressDefaultToolProgressMessages).toBe(true);
    expectLastDraftUpdateText(draftStream, "_Preparing the smallest fix_");
    expect(draftUpdateTexts(draftStream).join("\n")).not.toContain("pnpm test");

    const updateCount = draftStream.update.mock.calls.length;
    capturedReplyOptions?.onVerboseProgressVisibility?.(() => true);
    expect(capturedReplyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(true);
    await requireCapturedItemEventHandler()({
      kind: "preamble",
      itemId: "preamble-3",
      progressText: "Delivered by the verbose lane",
    });
    expect(draftStream.update).toHaveBeenCalledTimes(updateCount);
  });

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

    await normalizeSlackOutboundTextMock.withImplementation(
      normalizeSlackOutboundText,
      async () => {
        await dispatch({
          accountConfig: progressAccount({ label: false, commentary: true, toolProgress: false }),
        });
      },
    );

    expectLastDraftUpdateText(
      draftStream,
      "_checking &lt;@U123&gt; in &lt;#C123&gt; and &lt;!channel&gt; with urgent context `src/one.ts` &amp; Linux x86_64_",
    );
  });

  it.each([
    { commentary: true, style: "compact" as const, native: true },
    { commentary: undefined, style: undefined, native: false },
  ])(
    "keeps only preambles through reasoning and failed tools (style=$style, native=$native, commentary=$commentary)",
    async ({ style, native, commentary }) => {
      const draftStream = useDraftStream();
      finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
      mockedNativeStreaming = native;

      mockedReplyOptionEvents = [
        checkpoint(async () => {
          if (!capturedReplyOptions) {
            throw new Error("expected Slack reply options");
          }
          await emitCompactProgressScenario(capturedReplyOptions);
        }),
      ];

      await dispatch({
        accountConfig: progressAccount({
          style,
          nativeTaskCards: true,
          label: false,
          commentary,
          toolProgress: false,
          maxLines: 1,
        }),
      });

      expect(createSlackDraftStreamMock).toHaveBeenCalledTimes(1);
      expect(startSlackStreamMock).not.toHaveBeenCalled();
      expect(appendSlackStreamMock).not.toHaveBeenCalled();
      expect(stopSlackStreamMock).not.toHaveBeenCalled();
      expect(
        draftStream.update.mock.calls.every(
          ([update]) => typeof update === "string" || !("blocks" in update),
        ),
      ).toBe(true);
      expect(draftUpdateTexts(draftStream)).toEqual(
        ["Checking the current Slack behavior.", "The fix is ready; I’m checking the result."].map(
          (text) => (commentary ? `_${text}_` : text),
        ),
      );
      expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
      expect(deliverRepliesMock).toHaveBeenCalledOnce();
      expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
      expect(draftStream.discardPending.mock.invocationCallOrder[0]).toBeLessThan(
        deliverRepliesMock.mock.invocationCallOrder[0]!,
      );
      expect(deliverRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
        draftStream.clear.mock.invocationCallOrder[0]!,
      );
    },
  );

  it.each([true])(
    "clears compact progress after a tool-delivered reply only when the turn succeeds (failed=%s)",
    async (failed) => {
      const draftStream = useDraftStream();

      mockedDispatchSequence = [];
      mockedSourceReplyDelivered = true;
      mockedAgentRunTerminalOutcome = failed ? "failed" : "completed";
      mockedReplyOptionEvents = [{ kind: "partial", text: "Preparing the video attachment." }];

      await dispatch({
        accountConfig: progressAccount({ style: "compact", commentary: true }),
      });

      expect(deliverRepliesMock).not.toHaveBeenCalled();
      expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
      if (!failed) {
        expect(draftStream.discardPending.mock.invocationCallOrder[0]).toBeLessThan(
          draftStream.clear.mock.invocationCallOrder[0]!,
        );
      }
      if (failed) {
        expect(draftStream.clear).not.toHaveBeenCalled();
      }
    },
  );

  it("publishes compact media finals before clearing the preview after a suppressed send", async () => {
    const draftStream = useDraftStream();

    const payload = { text: "The fix works.", mediaUrl: "https://example.com/demo.mp4" };
    mockedDispatchSequence = [
      { kind: "final", payload },
      { kind: "final", payload },
    ];
    deliverRepliesMock.mockResolvedValueOnce(undefined);
    deliverRepliesMock.mockImplementationOnce(async () => {
      expect(draftStream.clear).not.toHaveBeenCalled();
      return normalDeliveryResult;
    });

    await dispatch({
      accountConfig: progressAccount({ style: "compact" }),
    });

    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({ replies: [payload], replyThreadTs: THREAD_TS }),
    );
    expect(draftStream.clear).toHaveBeenCalled();
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
  });

  it("retracts and resumes Slack plans while retaining other block progress", async () => {
    const mode = "block";

    const draftStream = useDraftStream();
    mockedSlackStreamingMode = mode;
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "plan", phase: "update", steps: [{ step: "Inspect", status: "in_progress" }] },
      { kind: "assistant_start" },
      { kind: "plan", phase: "update", steps: [] },
      checkpoint(async () => {
        expect(draftStream.clear).toHaveBeenCalledTimes(1);
        expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
      }),
      { kind: "plan", phase: "update", steps: [{ step: "Resume", status: "in_progress" }] },
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
      accountConfig: { streaming: { mode, progress: { label: false } } },
    });
  });

  it("keeps one partial preview across reasoning and tool boundaries", async () => {
    const draftStream = useDraftStream();
    mockedSlackStreamingMode = "partial";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      { kind: "reasoning", text: "Checking the first path" },
      { kind: "reasoning_end" },
      { kind: "item", progressText: "tool one" },
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
    const eventScope = {
      teamId: "T_ENTERPRISE",
      client: eventClient,
    };

    await dispatch({ eventScope });
    await dispatch({ eventScope });

    expect(usersInfo).toHaveBeenCalledTimes(1);
    expect(usersInfo).toHaveBeenCalledWith({ token: "xoxb-test", user: "U123" });
    expectMockCallArgFields(startSlackStreamMock, 0, {
      client: eventClient,
      teamId: "T_RECIPIENT",
    });
    expectMockCallArgFields(startSlackStreamMock, 1, {
      client: eventClient,
      teamId: "T_RECIPIENT",
    });
  });

  it("does not count suppressed reasoning-only payloads as delivered", async () => {
    mockedNativeStreaming = false;
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "Reasoning:\n_hidden_", isReasoning: true } },
    ];

    await dispatch({
      cfg: {
        messages: {
          statusReactions: { enabled: true },
        },
      },
      ackReactionMessageTs: "171234.111",
      ackReactionPromise: Promise.resolve(true),
    });

    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.setDone).not.toHaveBeenCalled();
    expect(statusReactionControllerMock.restoreInitial).toHaveBeenCalledTimes(1);
  });

  it("suppresses reasoning payloads during a definite stream-rejection fallback", async () => {
    mockedNativeStreaming = true;
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "Let me analyze...", isReasoning: true } },
      { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
    ];
    startSlackStreamMock.mockRejectedValueOnce(
      new TestSlackStreamNotDeliveredError(FINAL_REPLY_TEXT, "missing_scope"),
    );

    await dispatch();

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expectDeliverReplyCall(0, FINAL_REPLY_TEXT);
  });

  it("keeps same-content tool and final payloads distinct after preview fallback", async () => {
    mockedDispatchSequence = [
      { kind: "tool", payload: { text: SAME_TEXT } },
      { kind: "final", payload: { text: SAME_TEXT } },
    ];

    await dispatch();

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expectDeliverReplyCall(0, SAME_TEXT);
    expectDeliverReplyCall(1, SAME_TEXT);
  });

  it("keeps multi-part block replies in the first reply thread after the plan is consumed", async () => {
    mockedReplyThreadTsSequence = [THREAD_TS, undefined];
    mockedDispatchSequence = [
      { kind: "block", payload: { text: "first block" } },
      { kind: "block", payload: { text: "second block" } },
    ];

    await dispatch({
      replyToMode: "first",
    });

    expect(deliverRepliesMock).toHaveBeenCalledTimes(2);
    expectDeliverReplyCall(0, "first block");
    expectDeliverReplyCall(1, "second block");
  });

  it("preserves normal final delivery when stale-preview cleanup fails", async () => {
    const draftStream = createDraftStreamStub();
    draftStream.clear.mockRejectedValueOnce(new Error("preview cleanup failed"));
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: { text: "Photo", mediaUrl: "https://example.com/a.png" },
      },
    ];

    await dispatch();

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("delivers TTS below a human interruption received while its preview was flushing", async () => {
    let messageId: string | undefined = "171234.567";
    const draftStream = {
      ...createDraftStreamStub(),
      flush: vi.fn(async () => {
        messageId = undefined;
      }),
      messageId: () => messageId,
      channelId: () => (messageId ? "C123" : undefined),
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: ttsPayload(),
      },
    ];

    await dispatch();

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledOnce();
    const delivery = delivered(0);
    expect(delivery.replies).toEqual([{ ...ttsPayload(), text: "Spoken answer" }]);
  });

  it("delivers complete oversized TTS text together with its media", async () => {
    const spokenText = "界".repeat(1_334);
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: ttsPayload(spokenText),
      },
    ];

    await dispatch();

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const delivery = delivered(0);
    expect(delivery.replies).toEqual([{ ...ttsPayload(spokenText), text: spokenText }]);
  });

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
    mockedDispatchSequence = [
      { kind: "final", payload },
      { kind: "final", payload },
    ];

    await dispatch({
      message: { thread_ts: undefined },
      replyToMode: "first",
    });

    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    const delivery = delivered(0);
    expectRecordFields(delivery, { replyThreadTs: THREAD_TS });
    expect(emitSlackMessageSentHooksMock).not.toHaveBeenCalled();
  });

  it("restores TTS text after preview finalization fails despite earlier visible delivery", async () => {
    const draftStream = useDraftStream();
    mockedReplyThreadTsSequence = [undefined];
    const payload = ttsPayload(undefined, true);
    mockedDispatchSequence = [{ kind: "final", payload }];
    await dispatch();
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalled();
    expectRecordFields(delivered(), { replyThreadTs: THREAD_TS });
    expect(delivered().replies).toEqual([{ ...payload, text: "Spoken answer" }]);
  });

  it("keeps chart semantics singular when TTS preview finalization fails", async () => {
    const draftStream = createDraftStreamStub();
    mockedSlackReplyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Spoken answer", verbatim: true },
      },
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
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedReplyThreadTsSequence = [undefined];
    const payload = {
      ...ttsPayload(),
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
    };
    mockedDispatchSequence = [{ kind: "final", payload }];

    await dispatch();

    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, {
      text: "Spoken answer\n\nRevenue (bar chart)\n- &lt;@U123&gt;: Q1: 12; Q2: 18",
      blocks: mockedSlackReplyBlocks,
    });
    expect(normalizeSlackOutboundTextMock).not.toHaveBeenCalled();

    expect(delivered().replies).toEqual([{ ...payload, text: "Spoken answer" }]);
  });

  it("keeps already-delivered TTS supplements audio-only without a draft preview", async () => {
    mockedSlackStreamingMode = "off";
    mockedBlockStreamingEnabled = true;
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: ttsPayload(undefined, true),
      },
    ];

    await dispatch();

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    const delivery = delivered(0);
    expect(delivery.replies).toEqual([ttsPayload(undefined, true)]);
  });

  it("passes an oversized rejected reply intact to the chunked fallback sender", async () => {
    mockedNativeStreaming = true;
    const oversized = "x".repeat(8500);
    mockedDispatchSequence = [
      { kind: "final", payload: { text: "already visible" } },
      { kind: "final", payload: { text: oversized } },
    ];
    const session = createNativeStreamSession();
    const rejection = new TestSlackStreamNotDeliveredError(oversized, "team_not_found");
    startSlackStreamMock.mockResolvedValueOnce(session);
    appendSlackStreamMock.mockImplementationOnce(async () => {
      session.pendingText = oversized;
      throw rejection;
    });
    stopSlackStreamMock.mockRejectedValueOnce(rejection);

    await dispatch();

    expect(postMessageMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledOnce();
    expectDeliverReplyCall(0, oversized, { textLimit: 4000 });
    expect(session.stopped).toBe(true);
  });

  it("awaits the Slack receipt for a short tool reply", async () => {
    const kind = "tool";

    mockedNativeStreaming = true;
    mockedDispatchSequence = [{ kind, payload: { text: "short reply" } }];
    let acknowledgedBeforeStop = false;
    startSlackStreamMock.mockImplementationOnce(async (input) => {
      const params = requireRecord(input, "stream start");
      return {
        channel: "C123",
        threadTs: THREAD_TS,
        stopped: false,
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

    expectMockCallArgFields(startSlackStreamMock, 0, {
      text: "short reply",
      chunks: [],
    });
    expect(acknowledgedBeforeStop).toBe(true);
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledOnce();
  });

  it("does not replay a stream start whose acknowledgement was lost", async () => {
    mockedNativeStreaming = true;
    const error = new Error("network socket closed");
    startSlackStreamMock.mockRejectedValueOnce(error);

    await expect(dispatch()).rejects.toBe(error);

    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(stopSlackStreamMock).not.toHaveBeenCalled();
    expect(postMessageMock).not.toHaveBeenCalled();
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: FINAL_REPLY_TEXT, success: false, error: error.message }),
    );
  });

  it.each(["update", "completion"])(
    "keeps acknowledged narration successful when optional progress %s fails",
    async (phase) => {
      mockedNativeStreaming = true;
      mockedSlackStreamingMode = "progress";
      mockedProgressEvents = phase === "completion" ? ["working"] : [];
      mockedDispatchSequence = [
        { kind: "block", payload: { text: "acknowledged narration" } },
        ...(phase === "update" ? [{ kind: "item" as const, progressText: "working" }] : []),
        { kind: "final", payload: { text: FINAL_REPLY_TEXT } },
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
        { kind: "final", payload: { text: "already visible" } },
        { kind: "final", payload: { text: "stopped reply" } },
        { kind: "final", payload: { text: "after Stop" } },
      ];
      const session = {
        channel: "C123",
        threadTs: THREAD_TS,
        stopped: false,
        stoppedBySlack: false,
        delivered: true,
        pendingText: "",
      };
      startSlackStreamMock.mockResolvedValueOnce(session);
      appendSlackStreamMock.mockImplementationOnce(async () => {
        session.stopped = true;
        session.stoppedBySlack = true;
        session.pendingText = acknowledged ? "" : "stopped reply";
      });

      await dispatch();

      expect(appendSlackStreamMock).toHaveBeenCalledOnce();
      expect(stopSlackStreamMock).not.toHaveBeenCalled();
      expect(deliverRepliesMock).not.toHaveBeenCalled();
      expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(2);
      expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, {
        content: "already visible",
        success: true,
      });
      expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, {
        content: "stopped reply",
        success: acknowledged,
        ...(acknowledged ? { messageId: STREAM_MESSAGE_TS } : { error: "Stopped by Slack user" }),
      });
    },
  );

  it("preserves an acknowledged final answer when empty stream finalization loses its response", async () => {
    mockedNativeStreaming = true;
    stopSlackStreamMock.mockRejectedValueOnce(new Error("network socket closed"));

    const result = await dispatch({
      cfg: { messages: { statusReactions: { enabled: true } } },
      ackReactionMessageTs: "171234.111",
      ackReactionPromise: Promise.resolve(true),
    }).catch((caught: unknown) => caught);

    expect({
      errorReactions: statusReactionControllerMock.setError.mock.calls.length,
      doneReactions: statusReactionControllerMock.setDone.mock.calls.length,
      outcome: result,
    }).toEqual({ errorReactions: 0, doneReactions: 1, outcome: undefined });
    expectMockCallArgFields(startSlackStreamMock, 0, {
      text: FINAL_REPLY_TEXT,
      chunks: [],
    });
    expect(stopSlackStreamMock).toHaveBeenCalledOnce();
    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(emitSlackMessageSentHooksMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: FINAL_REPLY_TEXT, success: true }),
    );
  });

  it.each(["append", "stop"])(
    "does not replay pending text after an ambiguous %s failure",
    async (operation) => {
      mockedNativeStreaming = true;
      const prefix = "already visible";
      const terminalKind = "final";
      mockedDispatchSequence = [
        { kind: terminalKind, payload: { text: prefix } },
        { kind: "block", payload: { text: "second acknowledged" } },
        { kind: terminalKind, payload: { text: "failed reply" } },
      ];
      const session = createNativeStreamSession();
      startSlackStreamMock.mockResolvedValueOnce(session);
      const error = new Error("network socket closed");
      appendSlackStreamMock.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
        session.pendingText = "failed reply";
        if (operation === "append") {
          session.stopped = true;
          throw error;
        }
        if (operation === "stop") {
          throw new TestSlackStreamNotDeliveredError(session.pendingText, "user_not_found");
        }
      });
      stopSlackStreamMock.mockRejectedValueOnce(error);

      const result = await dispatch({
        cfg: { messages: { statusReactions: { enabled: true } } },
        ackReactionMessageTs: "171234.111",
        ackReactionPromise: Promise.resolve(true),
      }).catch((caught: unknown) => caught);
      expect({
        errorReactions: statusReactionControllerMock.setError.mock.calls.length,
        doneReactions: statusReactionControllerMock.setDone.mock.calls.length,
        outcome: result,
      }).toEqual({ errorReactions: 1, doneReactions: 0, outcome: error });

      expect(deliverRepliesMock).not.toHaveBeenCalled();
      expect(stopSlackStreamMock).toHaveBeenCalledTimes(operation === "append" ? 0 : 1);
      expect(postMessageMock).not.toHaveBeenCalled();
      expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(3);
      expectMockCallArgFields(emitSlackMessageSentHooksMock, 0, {
        content: prefix,
        success: true,
      });
      expectMockCallArgFields(emitSlackMessageSentHooksMock, 1, {
        content: "second acknowledged",
        success: true,
      });
      expectMockCallArgFields(emitSlackMessageSentHooksMock, 2, {
        content: "failed reply",
        success: false,
        error: error.message,
      });
    },
  );
  it("normalizes only authored preview text when blocks own their fallback", async () => {
    useDraftStream();
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: {
          text: "**Summary**",
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Owner <@U123>",
                    action: { type: "callback", value: "owner" },
                  },
                ],
              },
            ],
          },
        },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(normalizeSlackOutboundTextMock).toHaveBeenCalledTimes(1);
    expect(normalizeSlackOutboundTextMock).toHaveBeenCalledWith("**Summary**", {
      tableMode: "code",
    });
    expectMockCallArgFields(finalizeSlackPreviewEditMock, 0, {
      text: "**Summary**",
    });
  });

  it("delivers split table fallbacks normally instead of hiding them in a preview edit", async () => {
    const draftStream = createDraftStreamStub();
    const payload = {
      text: "Accounts",
      presentation: {
        blocks: [
          {
            type: "table",
            caption: "Account owners",
            headers: ["Owner"],
            rows: Array.from({ length: 100 }, (_entry, index) => [
              `owner-${String(index)}-${"x".repeat(110)}`,
            ]),
          },
          {
            type: "buttons",
            buttons: [{ label: "Refresh", value: "refresh" }],
          },
        ],
      },
    };
    createSlackDraftStreamMock.mockReturnValueOnce(draftStream);
    mockedDispatchSequence = [{ kind: "final", payload }];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    const delivery = delivered(0);
    expect(delivery.replies).toEqual([payload]);
  });

  it("keeps plan explanation in the session card with a fresh preamble", async () => {
    const draftStream = useDraftStream();

    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      preamble("Checking the workspace", "preamble-1"),
      {
        kind: "plan",
        phase: "update",
        explanation: "Executing the checklist.",
        steps: [{ step: "Patch", status: "in_progress" }],
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: progressAccount({ toolProgress: true, label: "Shelling" }),
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith({
      text: ["Shelling", "", "Checking the workspace", "", "▸ Patch"].join("\n"),
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "🔄 *Shelling*" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "_Checking the workspace — Executing the checklist._",
          },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: "▸ Patch" },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "⏱ 1s" }],
        },
      ],
    });
  });

  it("keeps and terminalizes the progress card when the final reply is an error", async () => {
    const draftStream = useDraftStream();
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);

    mockedDispatchSequence = [{ kind: "final", payload: { text: "tool failed", isError: true } }];
    mockedReplyOptionEvents = [{ kind: "item", progressText: "working" }];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: progressAccount(),
      }),
    );

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    const finalEdit = requireRecord(
      requireMockCall(finalizeSlackPreviewEditMock, 0, "error session card edit")[0],
      "error session card edit",
    );
    expect(JSON.stringify(finalEdit.blocks)).toContain("❌ *Working*");
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("preserves patch item identity in native Slack progress task updates", async () => {
    const taskId = expect.stringMatching(/^patch_item_1_[a-f0-9]{8}$/);

    await dispatchNativeProgressScenario({
      finalPayload: { text: FINAL_REPLY_TEXT },
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
    });

    expectNativeProgressStart([
      planUpdate("Apply Patch — updated Slack progress tests"),
      taskUpdate(taskId, "Apply Patch", "complete", {
        details: "updated Slack progress tests",
      }),
    ]);
    expect(collectNativeTaskUpdates()).toEqual([
      taskUpdate(taskId, "Apply Patch", "complete", { details: "updated Slack progress tests" }),
    ]);
    expectNativeStreamText(`\n${FINAL_REPLY_TEXT}`);
  });
  it("uses the default card title when no Slack progress label is configured", async () => {
    const draftStream = useDraftStream();
    finalizeSlackPreviewEditMock.mockResolvedValueOnce(undefined);
    mockedSlackStreamingMode = "progress";
    mockedDispatchSequence = [{ kind: "final", payload: { text: FINAL_REPLY_TEXT } }];
    mockedReplyOptionEvents = [
      { kind: "item", progressText: "tool one" },
      { kind: "partial", text: "partial answer" },
      { kind: "item", progressText: "tool two" },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      }),
    );

    expect(draftStream.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        blocks: expect.arrayContaining([
          { type: "section", text: { type: "mrkdwn", text: "🔄 *Working*" } },
        ]),
      }),
    );
    expect(finalizeSlackPreviewEditMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("renders the latest Slack preamble as the status headline by default", async () => {
    const draftStream = useDraftStream();
    mockedSlackStreamingMode = "progress";
    mockedDispatchSequence = [];
    mockedReplyOptionEvents = [
      {
        kind: "tool_start",
        itemId: "tool-1",
        name: "bash",
        phase: "start",
        args: { command: "pnpm test" },
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking the legacy Slack path",
      },
      {
        kind: "item",
        itemKind: "preamble",
        itemId: "preamble-2",
        progressText: "Keeping the released behavior",
      },
    ];

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: {
            mode: "progress",
            progress: { toolProgress: true, label: false, maxLines: 1 },
          },
        },
      }),
    );

    expect(capturedReplyOptions?.commentaryProgressEnabled).toBeUndefined();
    expect(capturedReplyOptions?.commentaryPayloadsEnabled).toBeUndefined();
    expect(capturedReplyOptions?.shouldDeliverCommentaryPayloads).toBeUndefined();
    expect(capturedReplyOptions?.onVerboseProgressVisibility).toBeUndefined();
    expect(capturedReplyOptions?.progressPreambleEnabled).toBe(true);
    expectLastDraftUpdateText(draftStream, "Keeping the released behavior\n\n🛠️ Bash: running");
  });

  it("does not flush draft previews for error finals before normal delivery", async () => {
    const draftStream = useDraftStream();
    mockedDispatchSequence = [
      {
        kind: "final",
        payload: { text: "Something failed", isError: true },
      },
    ];

    await dispatchPreparedSlackMessage(createPreparedSlackMessage());

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
