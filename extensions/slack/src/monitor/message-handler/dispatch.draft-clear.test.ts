import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
/**
 * Tests for draft-stream clearing before deliverNormally in the non-streaming
 * deliver path of dispatchPreparedSlackMessage.
 *
 * These verify that visible draft messages are cleared before falling back to
 * normal delivery, preventing duplicate messages in the channel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (hoisted) ----

const deliverRepliesMock = vi.fn().mockResolvedValue(undefined);
const createSlackReplyDeliveryPlanMock = vi.fn();
vi.mock("../replies.js", () => ({
  deliverReplies: (...args: unknown[]) => deliverRepliesMock(...args),
  createSlackReplyDeliveryPlan: (...args: unknown[]) => createSlackReplyDeliveryPlanMock(...args),
  readSlackReplyBlocks: () => undefined,
  resolveSlackThreadTs: vi.fn(),
}));

const draftStreamMock = {
  update: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  forceNewMessage: vi.fn(),
  messageId: vi.fn().mockReturnValue("1234.5678"),
  channelId: vi.fn().mockReturnValue("C_DRAFT"),
};
vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: () => draftStreamMock,
}));

let capturedDeliver: ((payload: ReplyPayload) => Promise<void>) | undefined;
vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createReplyDispatcherWithTyping: (opts: { deliver: (p: ReplyPayload) => Promise<void> }) => {
      capturedDeliver = opts.deliver;
      return {
        dispatcher: {},
        replyOptions: {},
        markDispatchIdle: vi.fn(),
        markRunComplete: vi.fn(),
      };
    },
    dispatchInboundMessage: (...args: unknown[]) => dispatchInboundMessageMock(...args),
    clearHistoryEntriesIfEnabled: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  resolveSendableOutboundReplyParts: (payload: ReplyPayload) => ({
    text: payload.text ?? "",
    trimmedText: payload.text?.trim() ?? "",
    hasText: Boolean(payload.text?.trim()),
    hasMedia: (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl),
  }),
}));

const dispatchInboundMessageMock = vi.fn();

const editSlackMessageMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../stream-mode.js", () => ({
  resolveSlackStreamingConfig: () => ({
    mode: "block",
    nativeStreaming: false,
    draftMode: "replace",
  }),
  applyAppendOnlyStreamUpdate: vi.fn(),
  buildStatusFinalPreviewText: vi.fn(),
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({ statusThreadTs: undefined, isThreadReply: false }),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/channel-runtime", () => ({
  removeAckReactionAfterReply: vi.fn(),
  logAckFailure: vi.fn(),
  logTypingFailure: vi.fn(),
  createReplyPrefixOptions: () => ({ onModelSelected: undefined }),
  createTypingCallbacks: () => ({
    onActive: undefined,
    onIdle: undefined,
  }),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  resolveStorePath: vi.fn(),
  updateLastRoute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  danger: (s: string) => s,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  resolveAgentOutboundIdentity: () => undefined,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("../../actions.js", () => ({
  editSlackMessage: (...args: unknown[]) => editSlackMessageMock(...args),
  reactSlackMessage: vi.fn().mockResolvedValue(undefined),
  removeSlackReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (s: string) => s,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: vi.fn(),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: vi.fn(),
  startSlackStream: vi.fn(),
  stopSlackStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../allow-list.js", () => ({
  normalizeSlackAllowOwnerEntry: vi.fn(),
}));

// ---- Imports under test (after mocks) ----

import { dispatchPreparedSlackMessage } from "./dispatch.js";
import type { PreparedSlackMessage } from "./types.js";

// ---- Helpers ----

function makePrepared(overrides?: Partial<PreparedSlackMessage>): PreparedSlackMessage {
  return {
    ctx: {
      cfg: {},
      runtime: { log: vi.fn(), error: vi.fn() },
      app: { client: { chat: { update: vi.fn().mockResolvedValue(undefined) } } },
      botToken: "xoxb-test",
      textLimit: 4000,
      teamId: "T1",
      typingReaction: undefined,
      removeAckAfterReply: false,
      allowFrom: [],
      channelHistories: new Map(),
      historyLimit: 10,
      setSlackThreadStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as PreparedSlackMessage["ctx"],
    account: {
      accountId: "acct-1",
      config: {
        streaming: "block",
        nativeStreaming: false,
        streamMode: undefined,
      },
    } as unknown as PreparedSlackMessage["account"],
    message: {
      channel: "C_TEST",
      user: "U_TEST",
      ts: "1000.1",
      text: "hello",
    } as unknown as PreparedSlackMessage["message"],
    route: {
      agentId: "agent-1",
      mainSessionKey: "sess-1",
      accountId: "acct-1",
    } as unknown as PreparedSlackMessage["route"],
    channelConfig: null,
    replyTarget: "channel:C_TEST",
    ctxPayload: {} as PreparedSlackMessage["ctxPayload"],
    replyToMode: "first",
    isDirectMessage: false,
    isRoomish: false,
    historyKey: "C_TEST",
    preview: "hello",
    ackReactionValue: "",
    ackReactionPromise: null,
    ...overrides,
  } as PreparedSlackMessage;
}

/**
 * Runs dispatchPreparedSlackMessage where `dispatchInboundMessage` calls the
 * given scenario function during execution (not after cleanup). This ensures
 * that the deliver callback runs with correct closure state.
 */
async function runWithScenario(
  scenario: (ctx: {
    deliver: (p: ReplyPayload) => Promise<void>;
    triggerPartialText: (text: string) => void;
  }) => Promise<void>,
  prepared?: PreparedSlackMessage,
) {
  dispatchInboundMessageMock.mockImplementationOnce(
    async (opts: { replyOptions: { onPartialReply?: (p: { text?: string }) => void } }) => {
      const onPartialReply = opts.replyOptions?.onPartialReply;

      await scenario({
        deliver: capturedDeliver!,
        triggerPartialText: (text: string) => onPartialReply?.({ text }),
      });

      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    },
  );

  await dispatchPreparedSlackMessage(prepared ?? makePrepared());
}

// ---- Tests ----

describe("draft clearing before deliverNormally (duplicate prevention)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedDeliver = undefined;
    draftStreamMock.messageId.mockReturnValue("1234.5678");
    draftStreamMock.channelId.mockReturnValue("C_DRAFT");

    createSlackReplyDeliveryPlanMock.mockReturnValue({
      nextThreadTs: () => "1000.1",
      markSent: vi.fn(),
    });
  });

  it("clears draft and delivers to correct thread when edit fails", async () => {
    await runWithScenario(async ({ deliver, triggerPartialText }) => {
      triggerPartialText("partial answer");

      editSlackMessageMock.mockRejectedValueOnce(new Error("channel_not_found"));

      draftStreamMock.clear.mockClear();
      deliverRepliesMock.mockClear();

      await deliver({ text: "final answer" });

      // Draft must be cleared before deliverNormally
      expect(draftStreamMock.clear).toHaveBeenCalledTimes(1);
      expect(deliverRepliesMock).toHaveBeenCalledTimes(1);

      // clear() must have been called BEFORE deliverReplies()
      const clearOrder = draftStreamMock.clear.mock.invocationCallOrder[0];
      const deliverOrder = deliverRepliesMock.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(deliverOrder);

      // Fallback must deliver to the thread the draft was in, not the main channel
      const deliverCall = deliverRepliesMock.mock.calls[0][0];
      expect(deliverCall.replyThreadTs).toBe("1000.1");
    });
  });

  it("clears draft for hasStreamedMessage edge case (isError payload)", async () => {
    await runWithScenario(async ({ deliver, triggerPartialText }) => {
      triggerPartialText("streaming content");

      draftStreamMock.clear.mockClear();
      deliverRepliesMock.mockClear();

      await deliver({ text: "Something went wrong", isError: true });

      expect(draftStreamMock.clear).toHaveBeenCalledTimes(1);
      expect(deliverRepliesMock).toHaveBeenCalledTimes(1);

      const clearOrder = draftStreamMock.clear.mock.invocationCallOrder[0];
      const deliverOrder = deliverRepliesMock.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(deliverOrder);
    });
  });

  it("clears draft for hasStreamedMessage edge case (empty text payload)", async () => {
    await runWithScenario(async ({ deliver, triggerPartialText }) => {
      triggerPartialText("streaming content");

      draftStreamMock.clear.mockClear();
      deliverRepliesMock.mockClear();

      await deliver({ text: "   " });

      expect(draftStreamMock.clear).toHaveBeenCalledTimes(1);
      expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not clear draft when finalize-via-edit succeeds", async () => {
    await runWithScenario(async ({ deliver }) => {
      draftStreamMock.clear.mockClear();

      await deliver({ text: "answer" });

      expect(draftStreamMock.clear).not.toHaveBeenCalled();
      expect(deliverRepliesMock).not.toHaveBeenCalled();
    });
  });

  it("resets hasStreamedMessage on successful edit so second payload does not delete first", async () => {
    await runWithScenario(async ({ deliver, triggerPartialText }) => {
      triggerPartialText("partial");

      // First payload: finalize-via-edit succeeds, turning draft into final message
      draftStreamMock.clear.mockClear();
      deliverRepliesMock.mockClear();
      await deliver({ text: "first reply" });

      expect(editSlackMessageMock).toHaveBeenCalledTimes(1);
      expect(draftStreamMock.clear).not.toHaveBeenCalled();

      // Second payload: hasStreamedMessage should be false now, so the
      // else-if(hasStreamedMessage) branch should NOT fire and delete the first reply.
      // With no draftMessageId from a new stream, canFinalizeViaPreviewEdit is still
      // true (messageId mock persists), so it will try edit again. That's fine —
      // the key assertion is that clear() is NOT called.
      draftStreamMock.clear.mockClear();
      editSlackMessageMock.mockClear();
      await deliver({ text: "second reply" });

      expect(draftStreamMock.clear).not.toHaveBeenCalled();
    });
  });

  it("clears draft exactly once when edit fails with active stream", async () => {
    await runWithScenario(async ({ deliver, triggerPartialText }) => {
      triggerPartialText("partial");

      draftStreamMock.clear.mockClear();
      editSlackMessageMock.mockRejectedValueOnce(new Error("edit_failed"));

      await deliver({ text: "final answer" });

      expect(draftStreamMock.clear).toHaveBeenCalledTimes(1);
      expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not clear draft when hasStreamedMessage is false and no edit attempt", async () => {
    draftStreamMock.messageId.mockReturnValue(undefined);
    draftStreamMock.channelId.mockReturnValue(undefined);

    await runWithScenario(async ({ deliver }) => {
      draftStreamMock.clear.mockClear();

      await deliver({ text: "answer" });

      expect(draftStreamMock.clear).not.toHaveBeenCalled();
      expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    });
  });
});
