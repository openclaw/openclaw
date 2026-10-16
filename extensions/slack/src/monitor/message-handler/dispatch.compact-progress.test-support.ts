import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { expect, vi } from "vitest";
import { requireRecord } from "./dispatch.preview.test-support.js";
import type { PreparedSlackMessage } from "./types.js";

export type SlackReplyOptionEvent =
  | {
      kind: "item";
      itemId?: string;
      toolCallId?: string;
      itemKind?: string;
      progressText?: string;
      summary?: string;
      title?: string;
      name?: string;
      phase?: string;
      status?: string;
      meta?: string;
    }
  | {
      kind: "tool_start";
      itemId?: string;
      toolCallId?: string;
      name: string;
      phase?: string;
      args?: Record<string, unknown>;
      detailMode?: "explain" | "raw";
    }
  | {
      kind: "plan";
      phase?: string;
      explanation?: string;
      explanationFormat?: "plain";
      steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
    }
  | { kind: "concurrent_items"; progressTexts: string[] }
  | { kind: "partial"; text: string }
  | { kind: "assistant_start" }
  | { kind: "reasoning"; text?: string; isReasoningSnapshot?: boolean }
  | { kind: "reasoning_end" }
  | { kind: "checkpoint"; run: () => Promise<void> }
  | ({ kind: "approval" } & Parameters<NonNullable<GetReplyOptions["onApprovalEvent"]>>[0]);

export const FAILED_COMMAND_ITEM = {
  itemId: "tool-2",
  kind: "tool",
  name: "bash",
  phase: "end",
  meta: "pnpm test",
  status: "failed",
} as const;

/** A model preamble stays visible while successful and failed work continues. */
export async function emitCompactProgressScenario(reply: GetReplyOptions) {
  await reply.onPlanUpdate?.({
    phase: "update",
    steps: [
      { step: "Inspect", status: "in_progress" },
      { step: "Patch", status: "pending" },
      { step: "Verify", status: "pending" },
    ],
  });
  await reply.onItemEvent?.({
    kind: "preamble",
    itemId: "preamble-1",
    phase: "end",
    progressText: "Checking the current Slack behavior.",
  });
  await reply.onToolStart?.({
    itemId: "tool-1",
    name: "bash",
    phase: "start",
    args: { command: "pnpm test" },
  });
  await reply.onItemEvent?.({
    itemId: "tool-1",
    kind: "tool",
    name: "bash",
    phase: "end",
    meta: "pnpm test",
    status: "completed",
  });
  await reply.onReasoningStream?.({ text: "Considering the transport choice." });
  await reply.onToolStart?.({
    toolCallId: "write-1",
    name: "write",
    phase: "start",
    args: { path: "result.txt", content: "fixed\n" },
  });
  await reply.onItemEvent?.({
    toolCallId: "write-1",
    kind: "tool",
    phase: "end",
    status: "completed",
  });
  await reply.onItemEvent?.({
    itemId: "patch-1",
    toolCallId: "patch-1",
    kind: "patch",
    name: "apply_patch",
    phase: "end",
    status: "completed",
    title: "Apply patch",
    meta: "result.txt",
  });
  await reply.onPlanUpdate?.({
    phase: "update",
    explanation: "Running the checklist.",
    steps: [{ step: "Patch", status: "in_progress" }],
  });
  await reply.onItemEvent?.({
    kind: "preamble",
    itemId: "preamble-2",
    phase: "end",
    progressText: "The fix is ready; I’m checking the result.",
  });
  await reply.onItemEvent?.(FAILED_COMMAND_ITEM);
  await reply.onPlanUpdate?.({
    phase: "update",
    explanation: "Finishing the checklist.",
    steps: [{ step: "Verify", status: "completed" }],
  });
}

export const THREAD_TS = "thread-1";

export const HUMAN_THREAD_REPLY = {
  accountId: "default",
  channelId: "C123",
  threadTs: THREAD_TS,
  messageTs: "171234.568",
  userId: "U_HUMAN",
};

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function planUpdate(title: string) {
  return { type: "plan_update", title };
}

export function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
  extra?: Record<string, unknown>,
) {
  return { type: "task_update", id, title, status, ...extra };
}

export function contentTaskId(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix}_[a-f0-9]{8}_1$`, "u"));
}

export function preamble(
  progressText: string,
  itemId: string,
  phase?: string,
): SlackReplyOptionEvent {
  return { kind: "item", itemKind: "preamble", progressText, itemId, phase };
}

export function checkpoint(run: () => Promise<void>): {
  kind: "checkpoint";
  run: () => Promise<void>;
} {
  return { kind: "checkpoint", run };
}

export function ttsPayload(spokenText = "Spoken answer", visibleTextAlreadyDelivered?: boolean) {
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
export const noopAsync = async () => {};
export function createNativeStreamSession() {
  return {
    channel: "C123",
    threadTs: THREAD_TS,
    stopped: false,
    delivered: true,
    pendingText: "",
  };
}

export function createDraftStreamStub() {
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

export function draftUpdateTexts(draftStream: ReturnType<typeof createDraftStreamStub>): string[] {
  return draftStream.update.mock.calls.map(([update]) => {
    if (typeof update === "string") {
      return update;
    }
    return requireRecord(update, "draft update").text as string;
  });
}

export function expectLastDraftUpdateText(
  draftStream: ReturnType<typeof createDraftStreamStub>,
  expected: string,
) {
  expect(draftUpdateTexts(draftStream).at(-1)).toBe(expected);
}

export function buildPreparedSlackMessage(
  params:
    | {
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
      }
    | undefined,
  chat: {
    postMessage: (...args: unknown[]) => Promise<unknown>;
    update: (...args: unknown[]) => Promise<unknown>;
  },
) {
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
      app: { client: { chat } },
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
