import { WebClient } from "@slack/web-api";
import { resolveChannelInboundRouteEnvelope } from "openclaw/plugin-sdk/channel-inbound";
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
} from "openclaw/plugin-sdk/reply-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slackSetupPlugin } from "../../channel.setup.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";
import type { PreparedSlackMessage } from "./types.js";

const FINAL_REPLY_TEXT = "final answer";
const THREAD_TS = "171234.100";
const PROGRESS_LINK_CONFIG = {
  gateway: {
    publicOrigin: "https://team.openclaw.ai",
    controlUi: { basePath: "/openclaw" },
  },
};
const FIRST_WORK_SESSION = {
  sessionKey: "agent:agent-1:dashboard:10184088-first",
  url: "https://team.openclaw.ai/openclaw/chat/agent-1/10184088",
  label: "Review",
};
const BOUNDED_WORK_SESSIONS = {
  batches: [
    Array.from({ length: 6 }, (_, index) => ({
      sessionKey: `agent:agent-1:dashboard:work-${index + 1}`,
      url: `https://team.openclaw.ai/openclaw/chat/agent-1/work-${index + 1}`,
      ...(index === 0 ? { label: "🚀".repeat(40) } : {}),
    })),
  ],
  links: [
    {
      url: "https://team.openclaw.ai/openclaw/chat/agent-1/work-1",
      text: `Open ${"🚀".repeat(34)}…`,
    },
    { url: "https://team.openclaw.ai/openclaw/chat/agent-1/work-2", text: "Open work session 2" },
    { url: "https://team.openclaw.ai/openclaw/chat/agent-1/work-3", text: "Open work session 3" },
    { url: "https://team.openclaw.ai/openclaw/chat/agent-1/work-4", text: "Open work session 4" },
    { url: "https://team.openclaw.ai/openclaw/chat/agent-1/work-5", text: "Open work session 5" },
  ],
};

const requireRecord = createRequireRecord("object", "label-not-object");
const finalizeCard = vi.fn<typeof import("./preview-finalize.js").finalizeSlackPreviewEdit>();
const deliverReplies = vi.fn<typeof import("../replies.js").deliverReplies>();
const startStream = vi.fn(async (_input: unknown) => ({
  channel: "C123",
  threadTs: THREAD_TS,
  delivered: true,
  stopped: false,
  pendingText: "",
  streamer: { ts: "171234.567" },
}));
const appendStream = vi.fn(async (_input: unknown) => {});
const stopStream = vi.fn(async (_input: unknown) => ({ messageId: "171234.567" }));
let sessionBatches: readonly Parameters<
  NonNullable<GetReplyOptions["onVisibleWorkSessions"]>
>[0][] = [];
let draftStream: ReturnType<typeof createDraftStream>;

function createDraftStream() {
  return {
    update: vi.fn(),
    flush: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
    stop: vi.fn(),
    forceNewMessage: vi.fn(),
    dropDetachedMessages: vi.fn(async () => {}),
    finalizeMessage: vi.fn(async (_id: string, edit: () => Promise<void>) => {
      await edit();
      return true;
    }),
    messageId: () => "171234.567",
    channelId: () => "C123",
  };
}

vi.mock("../../draft-stream.js", () => ({ createSlackDraftStream: () => draftStream }));
vi.mock("./preview-finalize.js", () => ({
  finalizeSlackPreviewEdit: (...args: Parameters<typeof finalizeCard>) => finalizeCard(...args),
}));
vi.mock("../replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../replies.js")>()),
  deliverReplies: (...args: Parameters<typeof deliverReplies>) => deliverReplies(...args),
}));
vi.mock("../../streaming.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../streaming.js")>()),
  startSlackStream: (input: unknown) => startStream(input),
  appendSlackStream: (input: unknown) => appendStream(input),
  stopSlackStream: (input: { session: { stopped: boolean } }) => {
    input.session.stopped = true;
    return stopStream(input);
  },
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelMessageReplyPipeline: () => ({ onModelSelected: undefined }),
    createChannelProgressDraftCompositor: (
      params: Parameters<typeof actual.createChannelProgressDraftCompositor>[0],
    ) =>
      actual.createChannelProgressDraftCompositor({
        ...params,
        // Admission delay is tested by the compositor; this boundary observes admitted cards.
        setTimeoutFn: ((handler: () => void) => {
          handler();
          return 0 as never;
        }) as unknown as typeof setTimeout,
        clearTimeoutFn: (() => {}) as typeof clearTimeout,
      }),
  };
});
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    dispatchChannelInboundTurn: async (
      params: Parameters<typeof actual.dispatchChannelInboundTurn>[0],
    ) => {
      await params.replyOptions?.onItemEvent?.({
        kind: "tool",
        itemId: "work",
        name: "exec",
        phase: "start",
        progressText: "Reviewing changes",
      });
      for (const sessions of sessionBatches) {
        params.replyOptions?.onVisibleWorkSessions?.(sessions);
      }
      const dispatcher = createReplyDispatcher({
        deliver: params.delivery.deliver,
        onError: params.delivery.onError,
      });
      dispatcher.sendFinalReply({ text: FINAL_REPLY_TEXT });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        admission: { kind: "dispatch" } as const,
        dispatched: true as const,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
      };
    },
  };
});

let dispatchPreparedSlackMessage: typeof import("./dispatch.js").dispatchPreparedSlackMessage;
function preparedMessage(native: boolean): PreparedSlackMessage {
  const client = new WebClient();
  vi.spyOn(client, "apiCall").mockRejectedValue(new Error("Unexpected Slack API call"));
  vi.spyOn(client.users, "info").mockResolvedValue({
    ok: true,
    user: { id: "U123", team_id: "T1" },
  });
  const ctx = createInboundSlackTestContext({
    cfg: PROGRESS_LINK_CONFIG,
    appClient: client,
    replyToMode: "all",
  });
  const route = {
    ...resolveChannelInboundRouteEnvelope({
      cfg: {},
      channel: "slack",
      accountId: "default",
      peer: { kind: "group", id: "C123" },
    }).route,
    agentId: "agent-1",
    sessionKey: "agent:agent-1:slack:C123",
    mainSessionKey: "agent:agent-1:main",
  };
  return {
    ctx,
    account: createSlackTestAccount({
      streaming: {
        mode: "progress",
        progress: { style: "card", toolProgress: true, nativeTaskCards: native, label: "Shelling" },
      },
    }),
    message: {
      type: "message",
      channel: "C123",
      ts: "171234.111",
      thread_ts: THREAD_TS,
      user: "U123",
      text: "Review changes",
    },
    route,
    channelConfig: null,
    replyTarget: "channel:C123",
    ctxPayload: finalizeInboundContext({
      Body: "Review changes",
      SessionKey: route.sessionKey,
      MessageThreadId: THREAD_TS,
      From: "slack:C123",
      To: "channel:C123",
      Provider: "slack",
      Surface: "slack",
      ChatType: "channel",
    }),
    turn: { record: {} },
    replyToMode: "all",
    isDirectMessage: false,
    isRoomish: true,
    ackReactionValue: "",
    ackReactionPromise: null,
  };
}

function nativeChunks(calls: readonly (readonly unknown[])[]) {
  return calls.flatMap(([input]) => {
    const chunks = requireRecord(input, "native stream input").chunks;
    return Array.isArray(chunks) ? chunks.map((chunk) => requireRecord(chunk, "native chunk")) : [];
  });
}

describe("Slack progress visible work session links", () => {
  beforeAll(async () => {
    ({ dispatchPreparedSlackMessage } = await import("./dispatch.js"));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackSetupPlugin }]),
    );
    draftStream = createDraftStream();
    finalizeCard.mockResolvedValue(undefined);
    deliverReplies.mockResolvedValue({
      messageId: "normal-final",
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ messageId: "normal-final", channelId: "C123" }],
      }),
    });
    sessionBatches = [];
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  it("finalizes Block Kit links with bounded labels and numbered fallbacks", async () => {
    const { batches, links } = BOUNDED_WORK_SESSIONS;
    sessionBatches = batches;
    await dispatchPreparedSlackMessage(preparedMessage(false));
    expect(draftStream.update).toHaveBeenCalled();
    expect(JSON.stringify(draftStream.update.mock.calls)).not.toContain('"url":');
    expect(finalizeCard).toHaveBeenCalledOnce();
    const finalEdit = finalizeCard.mock.calls[0]?.[0];
    expect(finalEdit).toMatchObject({ channelId: "C123", messageId: "171234.567" });
    expect(finalEdit?.blocks?.[0]).toEqual({
      type: "section",
      text: { type: "plain_text", text: "Shelling", emoji: false },
    });
    expect(finalEdit?.blocks).not.toContainEqual({
      type: "section",
      text: { type: "plain_text", text: "Failed", emoji: false },
    });
    const actions = finalEdit?.blocks?.filter((block) => block.type === "actions");
    expect(actions).toHaveLength(1);
    const buttons = requireRecord(actions?.[0], "session actions").elements as Array<
      Record<string, unknown>
    >;
    expect(buttons.map(({ url, text }) => ({ url, text }))).toEqual(
      links.map(({ url, text }) => ({ url, text: { type: "plain_text", text } })),
    );
    expect(buttons[0]?.action_id).toBe("openclaw:session_link");
    expect(new Set(buttons.map(({ action_id }) => action_id)).size).toBe(buttons.length);
    for (const button of buttons) {
      expect(button.type).toBe("button");
      expect(button.action_id).toMatch(/^openclaw:session_link(?::.+)?$/u);
      const text = requireRecord(button.text, "session button text").text as string;
      expect(text.length).toBeLessThanOrEqual(75);
      expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(deliverReplies).toHaveBeenCalledOnce();
    expect(deliverReplies.mock.calls[0]?.[0].replies.map((reply) => reply.payload)).toEqual([
      { text: FINAL_REPLY_TEXT },
    ]);
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(startStream).not.toHaveBeenCalled();
  });

  it("completes native sources with one visible work session before final text", async () => {
    const links = [{ url: FIRST_WORK_SESSION.url, text: "Open work session" }];
    sessionBatches = [[FIRST_WORK_SESSION], [FIRST_WORK_SESSION]];
    await dispatchPreparedSlackMessage(preparedMessage(true));
    const initial = nativeChunks(startStream.mock.calls);
    expect(initial).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "task_update", status: "in_progress" }),
      ]),
    );
    expect(initial.every((chunk) => !chunk.sources)).toBe(true);
    const completion = nativeChunks([...appendStream.mock.calls, ...stopStream.mock.calls]);
    const linked = completion.filter((chunk) => chunk.sources);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      type: "task_update",
      status: "complete",
      sources: links.map(({ url, text }) => ({ type: "url_source", url, text })),
    });
    const sourceCall = appendStream.mock.calls.findIndex(([input]) =>
      nativeChunks([[input]]).some((chunk) => chunk.sources),
    );
    const finalCall = appendStream.mock.calls.findIndex(
      ([input]) => requireRecord(input, "native final").text === `\n${FINAL_REPLY_TEXT}`,
    );
    expect(sourceCall).toBeGreaterThanOrEqual(0);
    expect(finalCall).toBeGreaterThan(sourceCall);
    expect(stopStream).toHaveBeenCalledOnce();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(draftStream.update).not.toHaveBeenCalled();
  });
});
