import path from "node:path";
import { DEFAULT_EMOJIS, DEFAULT_TIMING } from "openclaw/plugin-sdk/channel-feedback";
import { resolveGroupThreadMentionFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi, afterEach } from "vitest";
import * as h from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  expectReactAckCallAt,
  expectReactionCallsContain,
  getReactionEmojis,
  requireRecord,
  expectFreshFinalText,
  expectRecordFields,
  runBase,
  sendFinal,
} from "./message-handler.process.test-helpers.js";

h.registerDiscordProcessTestLifecycle();
const dispatch = h.dispatchInboundMessageForTest;
const deliver = h.deliverDiscordReply;
const route = h.BASE_CHANNEL_ROUTE;

async function runAutomatic(
  overrides: Parameters<typeof h.createAutomaticSourceDeliveryContext>[0] = {},
) {
  await h.runProcessDiscordMessage(await h.createAutomaticSourceDeliveryContext(overrides));
}
const session = { store: "/tmp/openclaw-discord-process-test-sessions.json" };
const messageToolConfig = {
  messages: { groupChat: { visibleReplies: "message_tool" } },
  session,
} satisfies OpenClawConfig;
const quotedBotBody =
  'Automation "daily update" failed 1 times\nCheck automation history for details.';
const dispatchCtx = () => requireRecord(h.getLastDispatchCtx(), "dispatch context");
const expectCtx = (fields: Record<string, unknown>) => expectRecordFields(dispatchCtx(), fields);
function message(id: string, content: string | undefined, channelId = "c1") {
  return { id, channelId, content, timestamp: new Date().toISOString(), attachments: [] };
}
function attachment(filename: string, content_type: string, id: string) {
  return { id, url: `https://cdn.discordapp.com/attachments/${filename}`, content_type, filename };
}
function author(id: string, username: string, globalName = username) {
  return { id, username, globalName, discriminator: "0" };
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

it.each([
  ["never", 0],
  ["room_event", 0],
  ["message", 2],
] as const)("honors %s typing policy and admission refreshes", async (mode, refreshes) => {
  dispatch.mockImplementationOnce(async (params) => {
    if (mode === "message") {
      expect(h.typingMocksForTest.sendTyping).not.toHaveBeenCalled();
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
    expect(h.getLastDispatchReplyOptions()?.suppressTyping).toBe(true);
  }
  expect(h.typingMocksForTest.sendTyping).toHaveBeenCalledTimes(refreshes);
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("keeps one typing refresh loop for default message-tool replies", async () => {
  vi.useFakeTimers();
  dispatch.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.replyOptions?.onReplyStart?.();
    await vi.advanceTimersByTimeAsync(3_500);
    return h.createNoQueuedDispatchResult();
  });
  await runBase({
    shouldRequireMention: false,
    effectiveWasMentioned: false,
    discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
    cfg: messageToolConfig,
    route,
  });

  expect(h.createDiscordDraftStream).not.toHaveBeenCalled();
  expect(h.typingMocksForTest.sendTyping).toHaveBeenCalledTimes(2);
});

it.each(["delivery", "agent"] as const)("reacts to %s failure", async (failure) => {
  if (failure === "delivery") {
    dispatch.mockResolvedValueOnce({
      ...h.createNoQueuedDispatchResult(),
      settledReceipt: failedFinalReceipt,
    });
  } else {
    h.readAgentRunTerminalOutcomeForTest.mockReturnValueOnce("failed");
    dispatch.mockImplementationOnce((params) =>
      sendFinal(params, { text: "Something failed", isError: true }),
    );
  }
  await runAutomatic();
  if (failure === "agent") {
    expect(deliver).toHaveBeenCalledTimes(1);
  }
  const emojis = getReactionEmojis();
  expect(emojis).toContain(DEFAULT_EMOJIS.error);
  expect(emojis).not.toContain(DEFAULT_EMOJIS.done);
});

it.each([
  { target: "channel", args: { channelId: "c1" }, channelId: "c1", messageId: "tracked-m1" },
  { target: "user", args: { to: "user:u1" }, channelId: "dm-u1", messageId: "m1" },
])("routes source acknowledgements and tracked $target reactions", async (scenario) => {
  vi.useFakeTimers();
  const entered = createDeferred<void>();
  dispatch.mockImplementationOnce(async (params) => {
    entered.resolve();
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
    return h.createNoQueuedDispatchResult();
  });
  const running = runAutomatic({
    message: { id: "1001", timestamp: new Date().toISOString(), attachments: [] },
    messageChannelId: "fallback-channel",
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(DEFAULT_TIMING.debounceMs);
  await vi.runAllTimersAsync();
  await running;

  expectReactAckCallAt(0, "👀", {
    channelId: "fallback-channel",
    accountId: "default",
    ackReaction: "👀",
  });
  expectReactionCallsContain(scenario.channelId, scenario.messageId, "📈");
  expect(getReactionEmojis()).toEqual(["👀", "📈"]);
});

it("records the cancelled turn without delivering its block reply", async () => {
  const abortController = new AbortController();
  dispatch.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    abortController.abort();
    await params?.dispatcher.sendBlockReply({ text: "post-abort block payload" });
    return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
  });

  await runAutomatic({
    abortSignal: abortController.signal,
    baseSessionKey: route.sessionKey,
    route,
  });

  expect(h.logVerboseForTest).toHaveBeenCalledWith(
    "discord block reply skipped (aborted before delivery): target=channel:c1 session=agent:main:discord:channel:c1",
  );
  expect(deliver).not.toHaveBeenCalled();
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
    const ctx = await h.createAutomaticSourceDeliveryContext({
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
    ctx.threadBindings.touchThread = async () => {
      touchEntered.resolve();
      await releaseTouch.promise;
      throw activityError;
    };
    dispatch.mockImplementation((params) =>
      sendFinal(params, { text: "Still received your message." }, false),
    );

    const processing = h.runProcessDiscordMessage(ctx);
    await touchEntered.promise;
    if (authority === "aborted") {
      abortController.abort();
    } else if (authority === "policy changed") {
      policyCurrent = false;
    }
    releaseTouch.resolve();
    await expect(processing).resolves.toBeUndefined();

    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(activityError.message),
    );
    const expectedDispatches = authority === "current" ? 1 : 0;
    for (const mock of [h.recordInboundSessionForTest, dispatch, deliver]) {
      expect(mock).toHaveBeenCalledTimes(expectedDispatches);
    }
    if (authority === "current") {
      expectFreshFinalText("Still received your message.");
    }
  },
);

const conflictError = () =>
  new Error("reply session initialization conflicted for agent:main:discord:channel:c1");

it.each([
  ["user_request", true, 1],
  ["room_event", true, 0],
  ["user_request", false, 1],
] as const)(
  "records terminal notice for %s (visible=%s)",
  async (inboundEventKind, visible, sends) => {
    dispatch.mockRejectedValue(conflictError());
    if (!visible) {
      deliver.mockResolvedValueOnce({ visibleReplySent: false });
    }
    const errorLog = vi.fn();
    const ctx = await h.createBaseContext({
      inboundEventKind,
      shouldRequireMention: false,
      effectiveWasMentioned: inboundEventKind !== "room_event",
      cfg: { messages: { groupChat: { visibleReplies: "automatic" } } },
      runtime: { log: vi.fn(), error: errorLog },
    });
    await expect(h.runProcessDiscordMessage(ctx)).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(h.recordInboundSessionForTest).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(sends);
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`terminal notice ${sends && visible ? "delivered" : "suppressed"}`),
    );
    if (sends === 1) {
      expectFreshFinalText(
        "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.",
      );
    }
  },
);

it("keeps exhaustion retryable when the visible failure notice cannot land", async () => {
  dispatch.mockRejectedValue(conflictError());
  deliver.mockRejectedValueOnce(new Error("Discord unavailable"));

  const failure = h.runProcessDiscordMessage(await h.createBaseContext());
  await expect(failure).rejects.toBeInstanceOf(Error);
  await expect(failure).rejects.toMatchObject({ cause: expect.any(Error) });
  expect(dispatch).toHaveBeenCalledTimes(4);
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("rebuilds a released replay without duplicating its pending history", async () => {
  const originalError = new Error("dispatch failed before completion");
  dispatch.mockRejectedValueOnce(originalError);
  const guildHistories = new Map();
  const createReplayContext = () =>
    h.createBaseContext({ guildHistories, historyLimit: 10, inboundEventKind: "room_event" });

  await expect(h.runProcessDiscordMessage(await createReplayContext())).rejects.toBe(originalError);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(guildHistories.get("c1")).toHaveLength(1);

  dispatch.mockResolvedValue(h.createNoQueuedDispatchResult());
  await h.runProcessDiscordMessage(await createReplayContext());

  expect(h.getLastDispatchCtx()?.Body).not.toContain("[Chat messages since your last reply");
  expect(guildHistories.get("c1")).toHaveLength(1);
  expect(guildHistories.get("c1")?.[0]?.messageId).toBe("1001");
});

it("treats an aborted conflict as cancellation", async () => {
  const abortController = new AbortController();
  dispatch.mockImplementationOnce(async () => {
    abortController.abort();
    throw conflictError();
  });

  await expect(runBase({ abortSignal: abortController.signal })).resolves.toBeUndefined();

  expect(dispatch).toHaveBeenCalledTimes(1);
});

it.each([true, false])("clears delivered room-event history (group DM=%s)", async (groupDm) => {
  const guildHistories = new Map();
  const notify = () =>
    h.discordInboundEventDelivery.notify({
      sessionKey: route.sessionKey,
      inboundEventKind: "room_event",
      to: "channel:c1",
      accountId: "default",
    });
  if (groupDm) {
    dispatch.mockImplementationOnce(async () => {
      notify();
      return h.createNoQueuedDispatchResult();
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
    baseSessionKey: route.sessionKey,
    route,
  });
  if (groupDm) {
    expect(h.getLastDispatchCtx()?.GroupRequireMention).toBe(false);
  } else {
    const begin = h.getLastDispatchReplyOptions()?.queuedDeliveryCorrelations?.[0]?.begin;
    expect(begin).toBeTypeOf("function");
    const end = begin?.();
    notify();
    end?.();
  }
  expect(guildHistories.get("c1")).toEqual([]);
});

it("omits starter context for an existing thread session", async () => {
  const id = "1001",
    key = `agent:main:discord:channel:${id}`;
  h.readSessionUpdatedAt.mockImplementation((params?: unknown) =>
    (params as { sessionKey?: string } | undefined)?.sessionKey === key
      ? 1_700_000_000_000
      : undefined,
  );
  await runBase({
    route,
    baseSessionKey: key,
    messageChannelId: id,
    threadChannel: { id, name: "child-thread" },
    threadParentId: "parent-1",
    cfg: { channels: { discord: { contextVisibility: "allowlist" } } },
    channelConfig: { allowed: true, users: ["U2"] },
    client: {
      rest: {
        get: vi.fn(async () => ({
          content: "original thread starter",
          embeds: [],
          timestamp: new Date().toISOString(),
          author: author("U2", "bob"),
        })),
      },
    },
  });
  expectCtx({
    SessionKey: key,
    MessageThreadId: id,
    ThreadLabel: "Discord thread #parent",
    ThreadStarterBody: undefined,
  });
});

it("frames preflight audio transcript in dispatch context and marks media transcribed", async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error("prepared media must not be fetched again");
  });
  const audio = { path: "/tmp/openclaw-discord-test/voice.ogg", contentType: "audio/ogg" };
  await runBase({
    discordRestFetch: fetchImpl,
    message: {
      ...message("m-audio-preflight", ""),
      attachments: [attachment("voice.ogg", "audio/ogg", "att-audio-preflight")],
    },
    baseText: "",
    messageText: "",
    preflightAudioTranscript: "/status",
    preparedMedia: [audio],
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
    media: [expect.objectContaining({ ...audio, transcribed: true })],
  });
  expect(h.getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
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
          author: author(
            bot ? "bot-1" : "U2",
            username,
            hidden ? "Mallory" : bot ? "Spartacus" : "Bob",
          ),
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

it("pins main DM routes without losing direct-message identity", async () => {
  const key = "agent:main:main";
  await runBase({
    ...h.createDirectMessageContextOverrides(),
    cfg: { messages: { ackReaction: "👀" }, session: { ...session, dmScope: "main" } },
    channelConfig: { users: ["user:111"] },
    baseSessionKey: key,
    author: author("222", "bob", "Bob"),
    sender: { id: "222", label: "bob" },
    route: { ...route, sessionKey: key },
  });
  expect(h.getLastRouteUpdate()).toMatchObject({
    sessionKey: key,
    channel: "discord",
    to: "user:222",
    accountId: "default",
    mainDmOwnerPin: { ownerRecipient: "111", senderRecipient: "222" },
  });
  expectCtx({
    ChatType: "direct",
    From: "discord:222",
    To: "user:222",
    OriginatingTo: "user:222",
    SessionKey: key,
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    broadcast: { "discord:c1": agents },
  };
  const ctx = await h.createAutomaticSourceDeliveryContext({
    cfg,
    route,
    baseSessionKey: route.sessionKey,
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
  h.dispatchBufferedReplyForTest.mockImplementationOnce((params) =>
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
  await h.runProcessDiscordMessage(ctx);

  expect(errors.mock.calls).toEqual([]);
  expect(participantRuns).toEqual(agents);
  expect(deliver).toHaveBeenCalledTimes(agents.length * 2);
  for (const agentId of agents) {
    const workspace = workspaceFor(agentId);
    for (const kind of ["block", "final"]) {
      const reply =
        warning && kind === "final"
          ? { text: "The attachment could not be processed." }
          : {
              mediaUrl: path.join(workspace, `${kind === "block" ? "reasoning" : "answer"}.txt`),
            };
      expect(deliver).toHaveBeenCalledWith(
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
  expect(h.createDiscordDraftStream).not.toHaveBeenCalled();
});
