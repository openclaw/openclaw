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

async function runBase(overrides: Parameters<typeof createBaseContext>[0] = {}) {
  await runProcessDiscordMessage(await createBaseContext(overrides));
}

async function runAutomatic(
  overrides: Parameters<typeof createAutomaticSourceDeliveryContext>[0] = {},
) {
  await runProcessDiscordMessage(await createAutomaticSourceDeliveryContext(overrides));
}
async function runTimedAutomatic(
  dispatch: (params: DispatchInboundParams | undefined) => Promise<void>,
  overrides: Parameters<typeof createAutomaticSourceDeliveryContext>[0] = {},
  advance = 0,
) {
  vi.useFakeTimers();
  const entered = createDeferred<void>();
  dispatchInboundMessage.mockImplementationOnce(async (params) => {
    entered.resolve();
    await dispatch(params);
    return createNoQueuedDispatchResult();
  });
  const running = runAutomatic(overrides);
  await entered.promise;
  if (advance) {
    await vi.advanceTimersByTimeAsync(advance);
  }
  await vi.runAllTimersAsync();
  await running;
}

const session = { store: "/tmp/openclaw-discord-process-test-sessions.json" };
const messageToolConfig = {
  messages: { groupChat: { visibleReplies: "message_tool" } },
  session,
} satisfies OpenClawConfig;
const quotedBotBody =
  'Automation "daily update" failed 1 times\nCheck automation history for details.';
const dispatchCtx = () => requireRecord(getLastDispatchCtx(), "dispatch context");
const expectCtx = (fields: Record<string, unknown>) => expectRecordFields(dispatchCtx(), fields);
function message(id: string, content: string | undefined, channelId = "c1") {
  return { id, channelId, content, timestamp: new Date().toISOString(), attachments: [] };
}
function attachment(filename: string, content_type: string, id: string) {
  return { id, url: `https://cdn.discordapp.com/attachments/${filename}`, content_type, filename };
}
async function sendFinal(
  params: DispatchInboundParams | undefined,
  payload: Parameters<DispatchInboundParams["dispatcher"]["sendFinalReply"]>[0],
  wait = true,
) {
  await params?.dispatcher.sendFinalReply(payload);
  if (wait) {
    await params?.dispatcher.waitForIdle();
  }
  return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
}

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
    dispatchInboundMessage.mockImplementationOnce((params) =>
      sendFinal(params, { text: "hello" }, false),
    );
    await runAutomatic();
    const reaction = firstMockCall(sendMocks.reactMessageDiscord, "ack reaction");
    const delivery = firstMockCall(deliverDiscordReply, "reply delivery");
    expect(requireRecord(reaction[3], "feedback options").rest).toBe(feedbackRest);
    expect(requireRecord(delivery[0], "delivery params").rest).toBe(deliveryRest);
    expect(feedbackRest).not.toBe(deliveryRest);
  });

  it.each([
    ["never", 0],
    ["room_event", 0],
    ["message", 2],
  ] as const)("honors %s typing policy and admission refreshes", async (mode, refreshes) => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      if (mode === "message") {
        expect(typingMocks.sendTyping).not.toHaveBeenCalled();
        await params?.replyOptions?.onReplyStart?.();
        await params?.replyOptions?.onReplyStart?.();
      }
      return sendFinal(params, { text: "long reply" });
    });
    await runAutomatic(
      mode === "room_event"
        ? { inboundEventKind: mode }
        : { cfg: { agents: { defaults: { typingMode: mode } } } },
    );
    if (mode === "room_event") {
      expect(getLastDispatchReplyOptions()?.suppressTyping).toBe(true);
    }
    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(refreshes);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("keeps one typing refresh loop for default message-tool replies", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReplyStart?.();
      await vi.advanceTimersByTimeAsync(3_500);
      return createNoQueuedDispatchResult();
    });
    await runBase({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
      cfg: messageToolConfig,
      route: BASE_CHANNEL_ROUTE,
    });

    expectRecordFields(requireRecord(getLastDispatchReplyOptions(), "dispatch reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      typingKeepalive: false,
      disableBlockStreaming: true,
    });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(typingMocks.sendTyping).toHaveBeenCalledTimes(2);
  });

  it.each(["delivery", "agent"] as const)(
    "marks %s failure with an error reaction",
    async (failure) => {
      if (failure === "delivery") {
        dispatchInboundMessage.mockResolvedValueOnce({
          ...createNoQueuedDispatchResult(),
          settledReceipt: failedFinalReceipt,
        });
      } else {
        readAgentRunTerminalOutcome.mockReturnValueOnce("failed");
        dispatchInboundMessage.mockImplementationOnce((params) =>
          sendFinal(params, { text: "Something failed", isError: true }),
        );
      }
      await runAutomatic();
      if (failure === "agent") {
        expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
      }
      const emojis = getReactionEmojis();
      expect(emojis).toContain(DEFAULT_EMOJIS.error);
      expect(emojis).not.toContain(DEFAULT_EMOJIS.done);
    },
  );

  it.each([
    { target: "channel", args: { channelId: "c1" }, channelId: "c1", messageId: "tracked-m1" },
    { target: "user", args: { to: "user:u1" }, channelId: "dm-u1", messageId: "m1" },
  ])("routes source acknowledgements and tracked $target reactions", async (scenario) => {
    await runTimedAutomatic(
      async (params) => {
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
      },
      {
        message: { id: "1001", timestamp: new Date().toISOString(), attachments: [] },
        messageChannelId: "fallback-channel",
      },
      DEFAULT_TIMING.debounceMs,
    );

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
    await runTimedAutomatic(
      async (params) => {
        await params?.replyOptions?.onReasoningStream?.({});
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
        await params?.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
        await params?.replyOptions?.onCompactionStart?.();
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
        await params?.replyOptions?.onCompactionEnd?.();
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.stallHardMs + 1_000);
      },
      {
        cfg: { messages: { ackReaction: "👀" }, session },
      },
    );

    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(sendMocks.removeReactionDiscord).not.toHaveBeenCalled();
  });
  it("records the cancelled turn without delivering its block reply", async () => {
    const abortController = new AbortController();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      abortController.abort();
      await params?.dispatcher.sendBlockReply({ text: "post-abort block payload" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
    });

    await runAutomatic({
      abortSignal: abortController.signal,
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    expect(logVerbose).toHaveBeenCalledWith(
      "discord block reply skipped (aborted before delivery): target=channel:c1 session=agent:main:discord:channel:c1",
    );
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });
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
      dispatchInboundMessage.mockImplementation((params) =>
        sendFinal(params, { text: "Still received your message." }, false),
      );

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
      for (const mock of [recordInboundSession, dispatchInboundMessage, deliverDiscordReply]) {
        expect(mock).toHaveBeenCalledTimes(expectedDispatches);
      }
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
    ["user_request", "automatic", 1],
    ["room_event", "message_tool_only", 0],
  ] as const)("records terminal notice outcome for %s", async (inboundEventKind, mode, sends) => {
    dispatchInboundMessage.mockRejectedValue(conflictError());
    const errorLog = vi.fn();
    const ctx = await createBaseContext({
      inboundEventKind,
      shouldRequireMention: false,
      effectiveWasMentioned: inboundEventKind !== "room_event",
      cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
      runtime: { log: vi.fn(), error: errorLog },
    });
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe(mode);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(sends);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`terminal notice ${sends === 1 ? "delivered" : "suppressed"}`),
    );
    if (sends === 1) {
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
      createBaseContext({ guildHistories, historyLimit: 10, inboundEventKind: "room_event" });

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
      await runBase({
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

    await runBase({
      messageChannelId: "thread-1",
      threadChannel: { id: "thread-1", name: "subagent-thread" },
      boundSessionKey: "agent:main:subagent:child",
      threadBindings,
      route: BASE_CHANNEL_ROUTE,
    });

    expectCtx({
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
    await runBase({
      cfg: { channels: { discord: { contextVisibility: "allowlist" } } },
      baseSessionKey: threadSessionKey,
      route: BASE_CHANNEL_ROUTE,
      messageChannelId: threadId,
      message: message("m1", "follow-up", threadId),
      messageText: "follow-up",
      baseText: "follow-up",
      threadChannel: { id: threadId, name: "child-thread" },
      threadParentId: "parent-1",
      client: { rest },
      channelConfig: { allowed: true, users: ["U2"] },
    });

    expect(rest.get).toHaveBeenCalled();
    expectCtx({
      SessionKey: threadSessionKey,
      MessageThreadId: threadId,
      ThreadLabel: "Discord thread #parent",
      ThreadStarterBody: undefined,
    });
  });
});

describe("processDiscordMessage session routing", () => {
  it("frames preflight audio transcript in dispatch context and marks media transcribed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("prepared media must not be fetched again");
    });
    await runBase({
      discordRestFetch: fetchImpl,
      message: {
        ...message("m-audio-preflight", ""),
        attachments: [attachment("voice.ogg", "audio/ogg", "att-audio-preflight")],
      },
      baseText: "",
      messageText: "",
      preflightAudioTranscript: "/status",
      preparedMedia: [{ path: "/tmp/openclaw-discord-test/voice.ogg", contentType: "audio/ogg" }],
      cfg: messageToolConfig,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expectCtx({
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
    await runBase({
      baseText: "/status",
      messageText: "/status",
      hasControlCommand: true,
      commandAuthorized: true,
    });

    expect(dispatchCtx().CommandTurn).toEqual({
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "status",
      body: "/status",
    });
  });

  it.each(["hidden", "attachment-only", "bot-previous"] as const)(
    "preserves permitted reply context and media for %s",
    async (kind) => {
      const hidden = kind === "hidden";
      const bot = kind === "bot-previous";
      const replyId = `m-${kind}`;
      const text = bot ? "<@bot> hit that again" : "<@bot> what is this?";
      const username = hidden ? "mallory" : bot ? "Spartacus" : "bob";
      const body = hidden ? "hidden image" : bot ? quotedBotBody : "";
      const fetchImpl = vi.fn(async () => {
        if (hidden || bot) {
          throw new Error("reply media must not be fetched");
        }
        return new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } });
      });
      await runBase({
        cfg: {
          channels: { discord: { contextVisibility: hidden ? "allowlist" : "all" } },
          messages: { ackReaction: "👀" },
          session,
        },
        channelConfig: hidden ? { allowed: true, users: ["U1"] } : null,
        botUserId: bot ? "bot-1" : undefined,
        discordRestFetch: fetchImpl,
        message: {
          ...message("m-reply", text),
          messageReference: { type: 0, message_id: replyId, channel_id: "c1" },
          referencedMessage: {
            ...message(replyId, body),
            attachments: [attachment("reply.png", "image/png", "att-reply")],
            author: {
              id: bot ? "bot-1" : "U2",
              username,
              globalName: hidden ? "Mallory" : bot ? "Spartacus" : "Bob",
              discriminator: "0",
            },
          },
        },
        baseText: text,
        messageText: text,
      });
      expectCtx({ ReplyToId: replyId, ReplyToBody: bot ? body : undefined });
      if (!hidden) {
        expectCtx({ ReplyToSender: username });
      }
      if (hidden) {
        expectCtx({ MediaPath: undefined, MediaPaths: undefined });
      } else if (bot) {
        expectCtx({ RawBody: text, MediaPaths: undefined });
      } else {
        expectCtx({
          media: [expect.objectContaining({ contentType: "image/png", messageId: replyId })],
        });
      }
      expect(fetchImpl).toHaveBeenCalledTimes(hidden || bot ? 0 : 1);
    },
  );

  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    await runBase({
      ...createDirectMessageContextOverrides(),
      message: message("m1", undefined, "dm1"),
      messageChannelId: "dm1",
    });

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
    expectCtx({
      ChatType: "direct",
      From: "discord:U1",
      To: "user:U1",
      OriginatingTo: "user:U1",
      SessionKey: "agent:main:discord:direct:u1",
    });
  });

  it("pins Discord text DM main-route updates to the single configured DM owner", async () => {
    await runBase({
      ...createDirectMessageContextOverrides(),
      cfg: {
        messages: { ackReaction: "👀" },
        session: { ...session, dmScope: "main" },
      },
      channelConfig: { users: ["user:111"] },
      baseSessionKey: "agent:main:main",
      author: { id: "222", username: "bob", discriminator: "0", globalName: "Bob" },
      sender: { id: "222", label: "bob" },
      route: {
        ...BASE_CHANNEL_ROUTE,
        sessionKey: "agent:main:main",
      },
    });

    expect(getLastRouteUpdate()).toMatchObject({
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "user:222",
      accountId: "default",
      mainDmOwnerPin: { ownerRecipient: "111", senderRecipient: "222" },
    });
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Discord group-thread participant delivery", () => {
  it.each([
    { name: "parallel participants", agents: ["alice", "bob"] },
    { name: "deferred warning", agents: ["alice"], warning: true },
  ])("binds delivery to the $name", async ({ agents, warning }) => {
    const workspaceRoot = tempDirs.make("discord-group-thread-workspaces-");
    const workspaceFor = (agent: string) => path.join(workspaceRoot, `workspace-${agent}`);
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          ["main", "alice", "bob"].map((id) => [id, { workspace: workspaceFor(id) }]),
        ),
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
            mediaUrl: path.join(workspaceFor(agentId), "reasoning.txt"),
          });
          const queuedFinal = dispatcher.sendFinalReply(
            warning
              ? setReplyPayloadMetadata(
                  { text: "The attachment could not be processed.", isError: true },
                  { nonTerminalToolErrorWarning: true },
                )
              : {
                  text: `Answer from ${agentId}`,
                  mediaUrl: path.join(workspaceFor(agentId), "answer.txt"),
                },
          );
          return { queuedFinal, counts: dispatcher.getQueuedCounts() };
        },
      }),
    );
    await runProcessDiscordMessage(ctx);

    expect(errors.mock.calls).toEqual([]);
    expect(participantRuns).toEqual(agents);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(agents.length * 2);
    for (const agentId of agents) {
      const workspace = workspaceFor(agentId);
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
