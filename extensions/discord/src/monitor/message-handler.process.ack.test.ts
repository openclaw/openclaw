import { DEFAULT_EMOJIS, DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi, onTestFinished } from "vitest";
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
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
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
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
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
    dispatchInboundMessage.mockRejectedValueOnce(new Error("dispatch failed before completion"));
    const guildHistories = new Map();
    const createReplayContext = () =>
      createBaseContext({
        guildHistories,
        historyLimit: 10,
        inboundEventKind: "room_event",
      });

    await expect(runProcessDiscordMessage(await createReplayContext())).rejects.toBeInstanceOf(
      Error,
    );
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
