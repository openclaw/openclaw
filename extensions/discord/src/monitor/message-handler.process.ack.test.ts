import path from "node:path";
import { DEFAULT_EMOJIS, DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import { resolveGroupThreadMentionFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi, onTestFinished, afterEach } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createAutomaticSourceDeliveryContext,
  createBaseContext,
  createDiscordRestClientSpyForTest as createDiscordRestClientSpy,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  discordTargetMocksForTest as discordTargetMocks,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  readAgentRunTerminalOutcomeForTest as readAgentRunTerminalOutcome,
  getLastDispatchReplyOptions,
  runProcessDiscordMessage,
  sendMocksForTest as sendMocks,
  typingMocksForTest as typingMocks,
  registerDiscordProcessTestLifecycle,
  getLastDispatchCtx,
  logVerboseForTest as logVerbose,
  recordInboundSessionForTest as recordInboundSession,
  createThreadBindingManager,
  getLastRouteUpdate,
  discordInboundEventDelivery,
  readSessionUpdatedAt,
  createDirectMessageContextOverrides,
  createDiscordDraftStream,
  dispatchBufferedReplyForTest,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  expectReactAckCallAt,
  expectReactionCallsContain,
  firstMockCall,
  getReactionEmojis,
  requireRecord,
  expectFreshFinalText,
  expectRecordFields,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();
const emptyCounts = {
  delivered: 0,
  deliveredNotVisible: 0,
  cancelled: 0,
  failedBeforeSend: 0,
  failedAfterSend: 0,
};
const failedFinalReceipt = {
  counts: { tool: emptyCounts, block: emptyCounts, final: { ...emptyCounts, failedBeforeSend: 1 } },
  anyVisibleDelivered: false,
};

describe("processDiscordMessage ack reactions", () => {
  it("uses separate REST clients for feedback and reply delivery", async () => {
    const feedbackRest = {};
    const deliveryRest = {};
    const client = (rest: object) => ({
      token: "",
      rest,
      account: { accountId: "default", config: {} },
    });
    createDiscordRestClientSpy
      .mockReturnValueOnce(client(feedbackRest))
      .mockReturnValueOnce(client(deliveryRest));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "hello" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    await runProcessDiscordMessage(await createAutomaticSourceDeliveryContext());
    const reaction = firstMockCall(sendMocks.reactMessageDiscord, "ack reaction");
    const delivery = firstMockCall(deliverDiscordReply, "reply delivery");
    expect(requireRecord(reaction[3], "feedback options").rest).toBe(feedbackRest);
    expect(requireRecord(delivery[0], "delivery params").rest).toBe(deliveryRest);
    expect(feedbackRest).not.toBe(deliveryRest);
  });

  it.each([
    {
      name: "typing mode never",
      overrides: { cfg: { agents: { defaults: { typingMode: "never" } } } },
    },
    { name: "room events", overrides: { inboundEventKind: "room_event" } },
  ])("suppresses fast-reply typing for $name", async ({ name, overrides }) => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "fast reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    await runProcessDiscordMessage(await createAutomaticSourceDeliveryContext(overrides));
    if (name === "room events") {
      expect(getLastDispatchReplyOptions()?.suppressTyping).toBe(true);
    }
    expect(typingMocks.sendTyping).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("starts typing on admission and forwards repeated resolver refreshes", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(typingMocks.sendTyping).not.toHaveBeenCalled();
      await params?.replyOptions?.onReplyStart?.();
      await params?.replyOptions?.onReplyStart?.();
      await params?.dispatcher.sendFinalReply({ text: "long reply" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: { agents: { defaults: { typingMode: "message" } } },
    });

    await runProcessDiscordMessage(ctx);

    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("keeps one typing refresh loop for default message-tool replies", async () => {
    vi.useFakeTimers();
    try {
      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        await params?.replyOptions?.onReplyStart?.();
        await vi.advanceTimersByTimeAsync(3_500);
        return createNoQueuedDispatchResult();
      });
      const ctx = await createBaseContext({
        shouldRequireMention: false,
        effectiveWasMentioned: false,
        cfg: {
          messages: { groupChat: { visibleReplies: "message_tool" } },
          session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
        },
        route: BASE_CHANNEL_ROUTE,
      });

      await runProcessDiscordMessage(ctx);

      expect(getLastDispatchReplyOptions()?.typingKeepalive).toBe(false);
      expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks automatic visible replies as failed when final Discord delivery fails", async () => {
    dispatchInboundMessage.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { final: 0, tool: 0, block: 0 },
      settledReceipt: failedFinalReceipt,
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    const emojis = getReactionEmojis();
    expect(emojis).toContain(DEFAULT_EMOJIS.error);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.done);
  });

  it("marks a recovered agent failure as failed after delivering its visible error reply", async () => {
    readAgentRunTerminalOutcome.mockReturnValueOnce("failed");
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Something failed", isError: true });
      await params?.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: { final: 1, tool: 0, block: 0 },
      };
    });

    const ctx = await createAutomaticSourceDeliveryContext();

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    const emojis = getReactionEmojis();
    expect(emojis).toContain(DEFAULT_EMOJIS.error);
    expect(emojis).not.toContain(DEFAULT_EMOJIS.done);
  });

  it.each([
    { target: "channel", args: { channelId: "c1" }, channelId: "c1", messageId: "tracked-m1" },
    { target: "user", args: { to: "user:u1" }, channelId: "dm-u1", messageId: "m1" },
  ])("routes source acknowledgements and tracked $target reactions", async (scenario) => {
    vi.useFakeTimers();
    const dispatchEntered = createDeferred<void>();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      dispatchEntered.resolve();
      await params?.replyOptions?.onToolStart?.({
        name: "message",
        phase: "start",
        args: {
          action: "react",
          ...scenario.args,
          messageId: scenario.messageId,
          emoji: "📈",
          trackToolCalls: true,
        },
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, DEFAULT_TIMING.debounceMs);
      });
      return createNoQueuedDispatchResult();
    });
    const ctx = await createAutomaticSourceDeliveryContext({
      message: { id: "1001", timestamp: new Date().toISOString(), attachments: [] },
      messageChannelId: "fallback-channel",
    });
    const runPromise = runProcessDiscordMessage(ctx);
    await dispatchEntered.promise;
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
    await vi.runAllTimersAsync();
    await runPromise;

    expectReactAckCallAt(0, "👀", {
      channelId: "fallback-channel",
      accountId: "default",
      ackReaction: "👀",
    });
    if (scenario.target === "user") {
      const resolveCall = firstMockCall(
        discordTargetMocks.resolveDiscordTargetChannelId,
        "resolveDiscordTargetChannelId",
      );
      expect(resolveCall[0]).toBe("user:u1");
      expect(requireRecord(resolveCall[1], "Discord target resolve options").accountId).toBe(
        "default",
      );
    }
    expectReactionCallsContain(scenario.channelId, scenario.messageId, "📈");
    expect(getReactionEmojis()).toEqual(["👀", "📈"]);
  });

  it("keeps one acknowledgement through reasoning, tools, compaction, silence, and success", async () => {
    vi.useFakeTimers();
    const dispatchEntered = createDeferred<void>();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      dispatchEntered.resolve();
      await params?.replyOptions?.onReasoningStream?.({});
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      await params?.replyOptions?.onCompactionStart?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
      await params?.replyOptions?.onCompactionEnd?.();
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallHardMs + 1_000);
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      cfg: {
        messages: { ackReaction: "👀" },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    const runPromise = runProcessDiscordMessage(ctx);
    await dispatchEntered.promise;
    await vi.runAllTimersAsync();
    await runPromise;

    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });
});

describe("processDiscordMessage deliver-lambda abort logging", () => {
  it("records the cancelled turn without delivering its block reply", async () => {
    const abortController = new AbortController();
    // Abort after dispatch starts so the delivery boundary observes the cancelled turn.
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      abortController.abort();
      await params?.dispatcher.sendBlockReply({ text: "post-abort block payload" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      abortSignal: abortController.signal,
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(logVerbose).toHaveBeenCalledWith(
      "discord block reply skipped (aborted before delivery): target=channel:c1 session=agent:main:discord:channel:c1",
    );
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });
});

describe("processDiscordMessage thread binding activity failure", () => {
  it.each(["current", "aborted", "policy changed"] as const)(
    "continues only with the original inbound authority: %s",
    async (authority) => {
      const touchEntered = createDeferred<void>();
      const releaseTouch = createDeferred<void>();
      const abortController = new AbortController();
      let policyCurrent = true;
      const errorLog = vi.fn();
      const activityError = new Error("Discord thread binding changed during persistence");
      const ctx = await createAutomaticSourceDeliveryContext({
        abortSignal: abortController.signal,
        isPolicyCurrent: () => policyCurrent,
        runtime: { log: vi.fn(), error: errorLog },
        cfg: { messages: { statusReactions: { enabled: false } } },
        discordConfig: { streaming: { mode: "off" } },
      });
      ctx.threadBinding = {
        bindingId: "discord:default:c1",
        targetSessionKey: ctx.route.sessionKey,
        targetKind: "subagent",
        conversation: { channel: "discord", accountId: "default", conversationId: "c1" },
        status: "active",
        boundAt: 100,
      };
      const touchThread = vi.fn(async () => {
        touchEntered.resolve();
        await releaseTouch.promise;
        throw activityError;
      });
      ctx.threadBindings.touchThread = touchThread;
      dispatchInboundMessage.mockImplementation(async (params?: DispatchInboundParams) => {
        await params?.dispatcher.sendFinalReply({ text: "Still received your message." });
        return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
      });

      const processing = runProcessDiscordMessage(ctx);
      await touchEntered.promise;
      if (authority === "aborted") {
        abortController.abort();
      } else if (authority === "policy changed") {
        policyCurrent = false;
      }
      releaseTouch.resolve();
      await expect(processing).resolves.toBeUndefined();

      expect(touchThread).toHaveBeenCalledExactlyOnceWith({ threadId: "c1" });
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(activityError.message),
      );
      const expectedDispatches = authority === "current" ? 1 : 0;
      expect(recordInboundSession).toHaveBeenCalledTimes(expectedDispatches);
      expect(dispatchInboundMessage).toHaveBeenCalledTimes(expectedDispatches);
      expect(deliverDiscordReply).toHaveBeenCalledTimes(expectedDispatches);
      if (authority === "current") {
        expectFreshFinalText("Still received your message.");
      }
    },
  );
});

describe("processDiscordMessage reply session init conflict retry", () => {
  const conflictError = () =>
    new Error("reply session initialization conflicted for agent:main:discord:channel:c1");

  it.each([
    {
      name: "an automatic group request",
      visibleReplies: "automatic",
      inboundEventKind: "user_request",
      expectedMode: "automatic",
      expectedSends: 1,
    },
    {
      name: "an ambient room event",
      visibleReplies: "automatic",
      inboundEventKind: "room_event",
      expectedMode: "message_tool_only",
      expectedSends: 0,
    },
  ] as const)("completes $name with a recorded terminal notice outcome", async (scenario) => {
    dispatchInboundMessage.mockRejectedValue(conflictError());
    const errorLog = vi.fn();

    const ctx = await createBaseContext({
      inboundEventKind: scenario.inboundEventKind,
      shouldRequireMention: false,
      effectiveWasMentioned: scenario.inboundEventKind !== "room_event",
      cfg: { messages: { groupChat: { visibleReplies: scenario.visibleReplies } } },
      runtime: { log: vi.fn(), error: errorLog },
    });
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe(scenario.expectedMode);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(scenario.expectedSends);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `terminal notice ${scenario.expectedSends === 1 ? "delivered" : "suppressed"}`,
      ),
    );
    if (scenario.expectedSends === 1) {
      expectFreshFinalText(
        "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.",
      );
    }
  });

  it("records downstream suppression without claiming its terminal notice was delivered", async () => {
    dispatchInboundMessage.mockRejectedValue(conflictError());
    deliverDiscordReply.mockResolvedValueOnce({ visibleReplySent: false });
    const errorLog = vi.fn();
    const ctx = await createBaseContext({ runtime: { log: vi.fn(), error: errorLog } });

    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("terminal notice suppressed"),
    );
  });

  it("keeps exhaustion retryable when the visible failure notice cannot land", async () => {
    dispatchInboundMessage.mockRejectedValue(conflictError());
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    const ctx = await createBaseContext();
    const failure = runProcessDiscordMessage(ctx);
    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.toMatchObject({ cause: expect.any(Error) });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a released replay without duplicating its pending history", async () => {
    const originalError = new Error("dispatch failed before completion");
    dispatchInboundMessage.mockRejectedValueOnce(originalError);
    const guildHistories = new Map();
    const createReplayContext = () =>
      createBaseContext({
        guildHistories,
        historyLimit: 10,
        inboundEventKind: "room_event",
      });

    await expect(runProcessDiscordMessage(await createReplayContext())).rejects.toBe(originalError);
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(guildHistories.get("c1")).toHaveLength(1);

    dispatchInboundMessage.mockResolvedValue(createNoQueuedDispatchResult());
    await runProcessDiscordMessage(await createReplayContext());

    expect(getLastDispatchCtx()?.Body).not.toContain("[Chat messages since your last reply");
    expect(guildHistories.get("c1")).toHaveLength(1);
    expect(guildHistories.get("c1")?.[0]?.messageId).toBe("1001");
  });

  it("treats an aborted conflict as cancellation", async () => {
    const abortController = new AbortController();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      abortController.abort();
      throw conflictError();
    });

    const ctx = await createBaseContext({ abortSignal: abortController.signal });
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });
});

describe("processDiscordMessage session routing and room events", () => {
  it.each(["group DM action", "queued guild send"] as const)(
    "clears room-event history after a visible %s",
    async (delivery) => {
      const groupDm = delivery === "group DM action";
      const guildHistories = new Map();
      const notify = () =>
        discordInboundEventDelivery.notify({
          sessionKey: BASE_CHANNEL_ROUTE.sessionKey,
          inboundEventKind: "room_event",
          to: "channel:c1",
          accountId: "default",
        });
      if (groupDm) {
        dispatchInboundMessage.mockImplementationOnce(async () => {
          notify();
          return createNoQueuedDispatchResult();
        });
      }
      const ctx = await createBaseContext({
        guildHistories,
        historyLimit: 10,
        isGuildMessage: !groupDm,
        isGroupDm: groupDm,
        isDirectMessage: false,
        shouldRequireMention: false,
        effectiveWasMentioned: false,
        inboundEventKind: "room_event",
        baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
        route: BASE_CHANNEL_ROUTE,
      });
      await runProcessDiscordMessage(ctx);
      if (groupDm) {
        expect(getLastDispatchCtx()?.GroupRequireMention).toBe(false);
      } else {
        const begin = getLastDispatchReplyOptions()?.queuedDeliveryCorrelations?.[0]?.begin;
        expect(begin).toBeTypeOf("function");
        const end = begin?.();
        notify();
        end?.();
      }
      expect(guildHistories.get("c1")).toEqual([]);
    },
  );

  it("uses PluralKit original ids for inbound dedupe while preserving the Discord message id", async () => {
    const ctx = await createBaseContext({
      canonicalMessageId: "orig-123",
      message: {
        id: "proxy-456",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      MessageSid: "orig-123",
      MessageSidFull: "proxy-456",
    });
  });

  it("prefers bound session keys and sets MessageThreadId for bound thread messages", async () => {
    const threadBindings = await createThreadBindingManager({
      cfg: {} as import("openclaw/plugin-sdk/config-contracts").OpenClawConfig,
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    onTestFinished(() => threadBindings.stop());
    await threadBindings.bindTarget({
      threadId: "thread-1",
      channelId: "c-parent",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      introText: "",
    });

    const ctx = await createBaseContext({
      messageChannelId: "thread-1",
      threadChannel: { id: "thread-1", name: "subagent-thread" },
      boundSessionKey: "agent:main:subagent:child",
      threadBindings,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: "agent:main:subagent:child",
      MessageThreadId: "thread-1",
    });
    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:subagent:child",
      channel: "discord",
      to: "channel:thread-1",
      accountId: "default",
    });
  });

  it("omits thread starter context when the effective thread session already exists", async () => {
    const threadId = "1001";
    const threadSessionKey = `agent:main:discord:channel:${threadId}`;
    readSessionUpdatedAt.mockImplementation((params?: unknown) => {
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      return sessionKey === threadSessionKey ? 1_700_000_000_000 : undefined;
    });
    const rest = {
      get: vi.fn(async () => ({
        content: "original thread starter",
        embeds: [],
        author: { id: "U2", username: "bob", discriminator: "0" },
        timestamp: new Date().toISOString(),
      })),
    };
    const ctx = await createBaseContext({
      cfg: {
        channels: { discord: { contextVisibility: "allowlist" } },
      },
      baseSessionKey: threadSessionKey,
      route: BASE_CHANNEL_ROUTE,
      messageChannelId: threadId,
      message: {
        id: "m1",
        channelId: threadId,
        content: "follow-up",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageText: "follow-up",
      baseText: "follow-up",
      threadChannel: { id: threadId, name: "child-thread" },
      threadParentId: "parent-1",
      client: { rest },
      channelConfig: { allowed: true, users: ["U2"] },
    });

    await runProcessDiscordMessage(ctx);

    expect(rest.get).toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      SessionKey: threadSessionKey,
      MessageThreadId: threadId,
      ThreadLabel: "Discord thread #parent",
    });
    expect(getLastDispatchCtx()?.ThreadStarterBody).toBeUndefined();
  });
});

async function createQuotedContext(options: {
  replyId: string;
  body: string;
  author: { id: string; username: string; globalName: string };
  fetch: typeof fetch;
  text?: string;
  visibility?: "all" | "allowlist";
  botUserId?: string;
}) {
  const text = options.text ?? "<@bot> what is this?";
  return await createBaseContext({
    cfg: {
      channels: { discord: { contextVisibility: options.visibility ?? "all" } },
      messages: { ackReaction: "👀" },
      session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
    },
    channelConfig: options.visibility === "allowlist" ? { allowed: true, users: ["U1"] } : null,
    botUserId: options.botUserId,
    discordRestFetch: options.fetch,
    message: {
      id: "m-reply",
      channelId: "c1",
      content: text,
      timestamp: new Date().toISOString(),
      attachments: [],
      messageReference: { type: 0, message_id: options.replyId, channel_id: "c1" },
      referencedMessage: {
        id: options.replyId,
        channelId: "c1",
        content: options.body,
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-reply",
            url: "https://cdn.discordapp.com/attachments/reply.png",
            content_type: "image/png",
            filename: "reply.png",
          },
        ],
        author: { ...options.author, discriminator: "0" },
      },
    },
    baseText: text,
    messageText: text,
  });
}

describe("processDiscordMessage session routing", () => {
  it("frames preflight audio transcript in dispatch context and marks media transcribed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("prepared media must not be fetched again");
    });
    const ctx = await createBaseContext({
      discordRestFetch: fetchImpl,
      message: {
        id: "m-audio-preflight",
        channelId: "c1",
        content: "",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-audio-preflight",
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      baseText: "",
      messageText: "",
      preflightAudioTranscript: "/status",
      preparedMedia: [
        {
          path: "/tmp/openclaw-discord-test/voice.ogg",
          contentType: "audio/ogg",
        },
      ],
      cfg: {
        messages: { groupChat: { visibleReplies: "message_tool" } },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(fetchImpl).not.toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      BodyForAgent: '[Audio transcript (machine-generated, untrusted)]: "/status"',
      RawBody: "",
      CommandBody: "",
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        commandName: undefined,
        body: "",
      },
      Transcript: "/status",
      media: [
        expect.objectContaining({
          path: "/tmp/openclaw-discord-test/voice.ogg",
          contentType: "audio/ogg",
          transcribed: true,
        }),
      ],
    });
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("keeps typed control commands as explicit text command turns", async () => {
    const ctx = await createBaseContext({
      baseText: "/status",
      messageText: "/status",
      hasControlCommand: true,
      commandAuthorized: true,
    });

    await runProcessDiscordMessage(ctx);

    expect(requireRecord(getLastDispatchCtx(), "dispatch context").CommandTurn).toEqual({
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "status",
      body: "/status",
    });
  });

  it("does not attach referenced reply media when reply context is hidden", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("hidden reply media should not be fetched");
    });
    const ctx = await createQuotedContext({
      replyId: "m-hidden",
      body: "hidden image",
      author: { id: "U2", username: "mallory", globalName: "Mallory" },
      fetch: fetchImpl,
      visibility: "allowlist",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToId).toBe("m-hidden");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.MediaPath).toBeUndefined();
    expect(dispatchCtx.MediaPaths).toBeUndefined();
  });

  it("keeps attachment-only referenced messages as typed reply context", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } }),
    );
    const ctx = await createQuotedContext({
      replyId: "m-attachment-only",
      body: "",
      author: { id: "U2", username: "bob", globalName: "Bob" },
      fetch: fetchImpl,
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(dispatchCtx.ReplyToId).toBe("m-attachment-only");
    expect(dispatchCtx.ReplyToSender).toBe("bob");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.media).toEqual([
      expect.objectContaining({
        contentType: "image/png",
        messageId: "m-attachment-only",
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves a user's reply to bot text without fetching self media", async () => {
    const body = 'Automation "daily update" failed 1 times\nCheck automation history for details.';
    const fetchImpl = vi.fn(async () => {
      throw new Error("self-reply media should not be fetched");
    });
    const ctx = await createQuotedContext({
      replyId: "m-bot-previous",
      body,
      author: { id: "bot-1", username: "Spartacus", globalName: "Spartacus" },
      fetch: fetchImpl,
      botUserId: "bot-1",
      text: "<@bot> hit that again",
    });
    await runProcessDiscordMessage(ctx);
    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToId).toBe("m-bot-previous");
    expect(dispatchCtx.ReplyToSender).toBe("Spartacus");
    expect(dispatchCtx.ReplyToBody).toBe(body);
    expect(dispatchCtx.RawBody).toBe("<@bot> hit that again");
    expect(dispatchCtx.MediaPaths).toBeUndefined();
  });

  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      message: {
        id: "m1",
        channelId: "dm1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "dm1",
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      ChatType: "direct",
      From: "discord:U1",
      To: "user:U1",
      OriginatingTo: "user:U1",
      SessionKey: "agent:main:discord:direct:u1",
    });
  });

  it("pins Discord text DM main-route updates to the single configured DM owner", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      cfg: {
        messages: { ackReaction: "👀" },
        session: {
          store: "/tmp/openclaw-discord-process-test-sessions.json",
          dmScope: "main",
        },
      },
      channelConfig: { users: ["user:111"] },
      baseSessionKey: "agent:main:main",
      author: {
        id: "222",
        username: "bob",
        discriminator: "0",
        globalName: "Bob",
      },
      sender: { id: "222", label: "bob" },
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toMatchObject({
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "user:222",
      accountId: "default",
      mainDmOwnerPin: { ownerRecipient: "111", senderRecipient: "222" },
    });
  });

  it("marks explicit message-tool guild replies as message-tool-only and disables source streaming", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchReplyOptions(), "dispatch reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      typingKeepalive: false,
      disableBlockStreaming: true,
    });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Discord group-thread participant delivery", () => {
  it.each([
    { name: "parallel participants", agents: ["alice", "bob"] },
    { name: "deferred warning", agents: ["alice"], warning: true },
  ])("binds delivery to the $name", async ({ agents, warning }) => {
    const workspaceRoot = tempDirs.make("discord-group-thread-workspaces-");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: path.join(workspaceRoot, "workspace-main") },
          alice: { workspace: path.join(workspaceRoot, "workspace-alice") },
          bob: { workspace: path.join(workspaceRoot, "workspace-bob") },
        },
      },
      broadcast: agents ? { "discord:c1": agents } : undefined,
    };
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg,
      route: BASE_CHANNEL_ROUTE,
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: { streaming: { mode: "partial" } },
      groupThread: resolveGroupThreadMentionFacts({
        cfg,
        channel: "discord",
        peerId: "c1",
        text: "Review this attachment.",
      }),
    });
    const actual = await vi.importActual<typeof replyRuntime>("openclaw/plugin-sdk/reply-runtime");
    const errors = vi.spyOn(ctx.runtime, "error");
    const participantRuns: string[] = [];
    dispatchBufferedReplyForTest.mockImplementationOnce((params) =>
      actual.dispatchReplyWithBufferedBlockDispatcher({
        ...params,
        dispatchReplyFromConfig: async ({ ctx: participant, dispatcher }) => {
          const agentId = participant.AgentId ?? "main";
          participantRuns.push(agentId);
          dispatcher.sendBlockReply({
            text: `Reasoning from ${agentId}`,
            isReasoning: true,
            mediaUrl: path.join(workspaceRoot, `workspace-${agentId}`, "reasoning.txt"),
          });
          const queuedFinal = dispatcher.sendFinalReply(
            warning
              ? setReplyPayloadMetadata(
                  { text: "The attachment could not be processed.", isError: true },
                  { nonTerminalToolErrorWarning: true },
                )
              : {
                  text: `Answer from ${agentId}`,
                  mediaUrl: path.join(workspaceRoot, `workspace-${agentId}`, "answer.txt"),
                },
          );
          return { queuedFinal, counts: dispatcher.getQueuedCounts() };
        },
      }),
    );
    await runProcessDiscordMessage(ctx);

    const responders = agents;
    expect(errors.mock.calls).toEqual([]);
    expect(participantRuns).toEqual(responders);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(responders.length * 2);
    for (const agentId of responders) {
      const workspace = path.join(workspaceRoot, `workspace-${agentId}`);
      for (const kind of ["block", "final"]) {
        const reply =
          warning && kind === "final"
            ? { text: "The attachment could not be processed." }
            : {
                mediaUrl: path.join(workspace, `${kind === "block" ? "reasoning" : "answer"}.txt`),
              };
        expect(deliverDiscordReply).toHaveBeenCalledWith(
          expect.objectContaining({
            target: "channel:c1",
            accountId: "default",
            sessionKey: `agent:${agentId}:discord:channel:c1`,
            mediaLocalRoots: expect.arrayContaining([workspace]),
            kind,
            replies: [expect.objectContaining(reply)],
          }),
        );
      }
    }
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });
});
