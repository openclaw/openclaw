import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  notifyDiscordActiveTurnThreadCreated,
  notifyDiscordActiveTurnThreadReplyDelivered,
} from "../active-turn-thread-route.js";
import {
  BASE_CHANNEL_ROUTE,
  createDiscordDraftStream,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  getGlobalHookRunnerForTest as getGlobalHookRunner,
  getLastDispatchReplyOptions,
  getSessionEntry,
  readLatestAssistantTextByIdentity,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
  createNonTerminalToolWarningPayload,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createAutomaticDraftContext,
  createMockDraftStreamForTest,
  expectFreshFinalText,
  firstMockArg,
  getDeliveredFinalTexts,
  runSingleChunkFinalScenario,
  useProgressDraftStartDelay,
  createBlockModeContext,
  firstDispatchParams,
  mockDispatch,
  runBase,
  sendFinal,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();
const progressStreaming = { mode: "progress", progress: { toolProgress: true } } as const;

async function runDraft(overrides: Parameters<typeof createAutomaticDraftContext>[0] = {}) {
  await runProcessDiscordMessage(await createAutomaticDraftContext(overrides));
}
async function startPreparedTool(params: DispatchInboundParams | undefined) {
  const tool = { toolCallId: "exec-1", name: "exec", phase: "start" as const };
  await params?.replyOptions?.onItemEvent?.(projectAgentToolActivity(tool));
  await params?.replyOptions?.onToolStart?.(tool);
}

function mockFinalReply(payload: FinalReplyPayload, waitForIdle = false) {
  mockDispatch((params) => sendFinal(params, payload, waitForIdle));
}

describe("processDiscordMessage provider preview hook safety", () => {
  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses previews for %s hooks",
    async (hookName) => {
      getGlobalHookRunner.mockReturnValue({ hasHooks: vi.fn((name) => name === hookName) });
      if (hookName === "message_sending") {
        deliverDiscordReply.mockResolvedValueOnce({ visibleReplySent: false });
      }
      mockFinalReply({ text: "final answer" }, true);
      await runDraft({ discordConfig: { streaming: { mode: "partial" } } });
      expect(createDiscordDraftStream).not.toHaveBeenCalled();
      expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    },
  );
});

describe("processDiscordMessage draft streaming final delivery", () => {
  it("ignores reasoning-only previews and replaces trailing tokens with the prepared final", async () => {
    const draftStream = createMockDraftStreamForTest();
    mockDispatch(async (params) => {
      await params?.replyOptions?.onPartialReply?.({ text: "Reasoning:\nPrivate planning" });
      expect(draftStream.update).not.toHaveBeenCalled();
      await params?.replyOptions?.onPartialReply?.({ text: "answer\n\nNO_REPLY" });
      await params?.dispatcher.sendFinalReply({ text: "answer" });
    });
    await runDraft({ discordConfig: { streaming: { mode: "partial" } } });

    expect(draftStream.update).toHaveBeenCalledWith("answer\n\nNO_REPLY");
    expectFreshFinalText("answer");
    expect(draftStream.clear).toHaveBeenCalled();
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("sends a fresh final message for broadcast mentions like @everyone", async () => {
    mockFinalReply({ text: "heads up @everyone" }, true);

    await runDraft({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      allowedMentions: { parse: ["users", "roles"] },
      onPlatformSendDispatch: expect.any(Function),
    });
  });

  it("keeps answer deltas private with default progress and delivers the final normally", async () => {
    await runSingleChunkFinalScenario({ maxLinesPerMessage: 5 });
    expect(getLastDispatchReplyOptions()?.onPartialReply).toBeUndefined();
    expect(createDiscordDraftStream).toHaveBeenCalledOnce();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFreshFinalText("Hello\nWorld");
  });

  it("preserves compaction notices alongside the progress draft and final answer", async () => {
    const notices = [
      { text: "🧹 Compacting context...", isCompactionNotice: true },
      { text: "🧹 Compaction complete", isCompactionNotice: true },
    ];
    mockDispatch(async (params) => {
      await params?.dispatcher.sendBlockReply({ text: "private answer delta" });
      for (const notice of notices) {
        await params?.dispatcher.sendBlockReply(notice);
      }
      await sendFinal(params, { text: "final answer" });
    });
    await runDraft({ discordConfig: { streaming: { mode: "progress" } } });

    expect(createDiscordDraftStream).toHaveBeenCalledOnce();
    expect(deliverDiscordReply.mock.calls.map(([delivery]) => delivery)).toEqual([
      ...notices.map((notice) => expect.objectContaining({ kind: "block", replies: [notice] })),
      expect.objectContaining({ kind: "final", replies: [{ text: "final answer" }] }),
    ]);
  });

  it("does not attach a progress receipt when final delivery starts before the delay", async () => {
    vi.useFakeTimers();
    const draftStream = createMockDraftStreamForTest();
    const lookupStarted = createDeferred<void>();
    const transcript =
      createDeferred<Awaited<ReturnType<typeof readLatestAssistantTextByIdentity>>>();
    const truncatedFinal =
      "Here is the complete Discord answer with enough stable prefix text before truncation...";

    getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    readLatestAssistantTextByIdentity.mockImplementationOnce(() => {
      lookupStarted.resolve();
      return transcript.promise;
    });
    mockDispatch(async (params) => {
      await startPreparedTool(params);
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
      await lookupStarted.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      transcript.resolve(undefined);
      await params?.dispatcher.waitForIdle();
    });

    await runDraft({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: {
        streaming: progressStreaming,
        maxLinesPerMessage: 5,
      },
      route: BASE_CHANNEL_ROUTE,
    });

    expect(draftStream.update).not.toHaveBeenCalled();
    expectFreshFinalText(truncatedFinal);
    expect(getDeliveredFinalTexts()[0]).not.toContain("\n-# ");
  });

  it("renders narration updates into the Discord progress draft", async () => {
    vi.useFakeTimers();
    const draftStream = createMockDraftStreamForTest();
    const beginTurn = vi.fn();
    const stopTurn = vi.fn();

    mockDispatch(async (params) => {
      params?.replyOptions?.onProgressNarratorLifecycle?.({ beginTurn, stopTurn });
      await startPreparedTool(params);
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(false);
      await params?.replyOptions?.onNarrationUpdate?.({
        text: "Reading the gateway config and restarting agents.",
      });
      expect(draftStream.update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(true);
      await params?.dispatcher.sendFinalReply({ text: "done" });
      expect(params?.replyOptions?.isProgressDraftVisible?.()).toBe(false);
      expect(stopTurn).toHaveBeenCalled();
      await params?.replyOptions?.onAssistantMessageStart?.();
      expect(beginTurn).toHaveBeenCalledOnce();
    });

    await runDraft({
      discordConfig: {
        streaming: progressStreaming,
        maxLinesPerMessage: 5,
      },
    });

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toContain(
      "Reading the gateway config and restarting agents.\n\n🛠️ Exec: running",
    );
    expectFreshFinalText("done");
  });

  it("retires coding-profile guild progress only after a confirmed message-tool reply", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    mockDispatch(async (params) => {
      expect(params?.replyOptions?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(params?.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      await startPreparedTool(params);
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      expect(draftStream.messageId()).toBeDefined();
      await params?.replyOptions?.onObservedReplyDelivery?.();
      expect(draftStream.messageId()).toBeUndefined();
      await params?.replyOptions?.onItemEvent?.({ progressText: "late progress" });
      expect(draftStream.messageId()).toBeUndefined();
      return createNoQueuedDispatchResult();
    });

    await runBase({
      discordConfig: { streaming: progressStreaming },
      cfg: {
        channels: {
          discord: { streaming: progressStreaming },
        },
        tools: { profile: "coding" },
        messages: { groupChat: { visibleReplies: "message_tool" } },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(draftStream.update).toHaveBeenCalledWith("Working\n\n🛠️ Exec: running\n• exec done", {
      complete: true,
    });
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });
});

type AutomaticDeliveryOverrides = Parameters<typeof createAutomaticDraftContext>[0];
type FinalReplyPayload = Parameters<DispatchInboundParams["dispatcher"]["sendFinalReply"]>[0];

async function runFinalReplyScenario(
  payload: FinalReplyPayload,
  overrides: AutomaticDeliveryOverrides = {},
) {
  const draftStream = createMockDraftStreamForTest();
  mockFinalReply(payload);

  await runDraft({
    discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    ...overrides,
  });
  return draftStream;
}

describe("processDiscordMessage draft streaming recovery", () => {
  it("uses transcript-backed final text when progress final text is truncated", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    const prefix =
      "Here is the complete Discord answer with enough stable prefix text before truncation";
    const truncatedFinal = `${prefix}...`;
    const fullAnswer = `${prefix} ${Array.from(
      { length: 260 },
      (_value, index) => `continuation${index}`,
    ).join(" ")}`;

    getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 60_000,
    });
    mockDispatch(async (params) => {
      await startPreparedTool(params);
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
    });

    await runDraft({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: {
        streaming: progressStreaming,
        maxLinesPerMessage: 120,
      },
      route: BASE_CHANNEL_ROUTE,
    });

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFreshFinalText(fullAnswer);
  });

  it.each([false, true])(
    "delivers TTS supplement (visible text already delivered: %s)",
    async (delivered) => {
      const ttsSupplement = {
        spokenText: "Spoken answer",
        ...(delivered ? { visibleTextAlreadyDelivered: true } : {}),
      };
      const draftStream = await runFinalReplyScenario(
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement,
        } as never,
        delivered ? {} : { replyToMode: "first" },
      );
      if (!delivered) {
        expect(draftStream.flush).not.toHaveBeenCalled();
        expect(draftStream.messageId()).toBeUndefined();
      }
      expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
      expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
        ...(delivered ? {} : { replyToId: "1001" }),
        replies: [
          {
            ...(delivered ? {} : { text: "Spoken answer" }),
            mediaUrl: "https://example.com/tts.mp3",
            audioAsVoice: true,
            spokenText: "Spoken answer",
            ttsSupplement: {
              spokenText: "Spoken answer",
              ...(delivered ? { visibleTextAlreadyDelivered: true } : {}),
            },
          },
        ],
      });
    },
  );

  it("suppresses tool warning finals when the recovered reply fails to send", async () => {
    deliverDiscordReply.mockRejectedValueOnce(new Error("send failed"));
    mockDispatch(async (params) => {
      await params?.dispatcher.sendFinalReply({ text: "delivery failed" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return {
        queuedFinal: true,
        counts: { final: 2, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    await runDraft({ discordConfig: { streaming: { mode: "off" } } });

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "delivery failed" }],
    });
  });

  it("renders reasoning-tagged final payloads as a 🧠 blockquote, never the final", async () => {
    mockFinalReply({
      text: "Reasoning:\nthis renders as a quoted thinking message",
      isReasoning: true,
    });

    await runDraft({ discordConfig: { streaming: { mode: "off" } } });

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "> 🧠 this renders as a quoted thinking message" }],
    });
  });

  it("starts a new block preview at an assistant boundary", async () => {
    const draftStream = createMockDraftStreamForTest();
    mockDispatch(async (params) => {
      await params?.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      return createNoQueuedDispatchResult();
    });
    await runProcessDiscordMessage(await createBlockModeContext());
    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(firstDispatchParams().replyOptions?.disableBlockStreaming).toBe(true);
  });
});

async function startToolProgress(params: DispatchInboundParams | undefined) {
  const tool = { name: "exec", toolCallId: "exec-1", phase: "start" as const };
  await params?.replyOptions?.onToolStart?.(tool);
  await params?.replyOptions?.onItemEvent?.(projectAgentToolActivity(tool));
}

async function runProgressScenario(
  progress: NonNullable<DiscordAccountConfig["streaming"]>["progress"],
) {
  await runDraft({ discordConfig: { streaming: { mode: "progress", progress } } });
}

describe("processDiscordMessage draft streaming progress", () => {
  it("moves progress and final delivery into a thread created from the source message", async () => {
    const draftStream = createMockDraftStreamForTest();
    mockDispatch(async (params) => {
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Investigating.",
      });
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey: String(params?.ctx?.SessionKey),
        accountId: "default",
        sourceChannelId: "c1",
        sourceMessageId: "1001",
        threadId: "thread-1",
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
    });
    await runProgressScenario({ toolProgress: true });

    expect(draftStream.retarget).toHaveBeenCalledWith("thread-1");
    expect(deliverDiscordReply).toHaveBeenCalledWith(
      expect.objectContaining({ target: "channel:thread-1", replyToId: undefined }),
    );
  });

  it("keeps adopted-thread progress with terminal tool and timing receipts", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    mockDispatch(async (params) => {
      await startToolProgress(params);
      await params?.replyOptions?.onItemEvent?.({
        itemId: "tool:exec-1",
        toolCallId: "exec-1",
        kind: "tool",
        name: "exec",
        phase: "end",
        status: "completed",
        progressText: "Checked the pipeline.",
      });
      await elapseProgressDraftStartDelay();
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey: String(params?.ctx?.SessionKey),
        accountId: "default",
        sourceChannelId: "c1",
        sourceMessageId: "1001",
        threadId: "thread-1",
      });
      expect(
        notifyDiscordActiveTurnThreadReplyDelivered({
          sessionKey: String(params?.ctx?.SessionKey),
          accountId: "default",
          threadId: "thread-1",
        }),
      ).toBe(true);
      return createNoQueuedDispatchResult();
    });
    await runProgressScenario({ toolProgress: true, label: "Investigating", commandText: "raw" });

    expect(draftStream.retarget).toHaveBeenCalledWith("thread-1");
    expect(draftStream.update).toHaveBeenLastCalledWith(
      "Investigating\n\n🛠️ Checked the pipeline.",
    );
    expect(draftStream.messageId()).toBeDefined();
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("re-arms progress collapse for a queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    mockDispatch(async (params) => {
      await startToolProgress(params);
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      expect(draftStream.messageId()).toBeUndefined();
      await params?.replyOptions?.onQueuedFollowupAdmitted?.();
      await params?.replyOptions?.onToolStart?.({ name: "read", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "second tool done" });
      await elapseProgressDraftStartDelay();
      expect(draftStream.messageId()).toBeDefined();
      expect(draftStream.lastDeliveredText()).toContain("second tool done");
      expect(draftStream.lastDeliveredText()).not.toContain("first tool done");
      await params?.dispatcher.sendFinalReply({ text: "second answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    await runProgressScenario({ toolProgress: true, label: "Shelling" });

    expect(draftStream.messageId()).toBeUndefined();
    expect(getDeliveredFinalTexts()).toEqual(["first answer", "second answer"]);
  });

  // A message queued behind an active turn runs after its own dispatch has
  // returned, and its final is routed outside deliverDiscordPayload (#149640).
  it("cleans up a late queued turn's progress draft after settlement", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    let replyOptions: DispatchInboundParams["replyOptions"];

    mockDispatch(async (params) => {
      replyOptions = params?.replyOptions;
      return createNoQueuedDispatchResult();
    });

    await runDraft({
      discordConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    await replyOptions?.onQueuedFollowupAdmitted?.();
    await replyOptions?.onToolStart?.({ name: "view_image", phase: "start" });
    await replyOptions?.onItemEvent?.({ progressText: "viewing image" });
    await elapseProgressDraftStartDelay();
    expect(draftStream.messageId()).toBeDefined();

    await replyOptions?.onQueuedFollowupSettled?.();

    expect(draftStream.messageId()).toBeUndefined();
  });
});

describe("processDiscordMessage queued thread replies", () => {
  it.each([true, false])(
    "recognizes a thread answer when queued execution starts before dispatch returns: %s",
    async (startsBeforeReturn) => {
      let endQueuedRoute: (() => void) | void = undefined;
      mockDispatch(async (params) => {
        if (startsBeforeReturn) {
          endQueuedRoute = params?.replyOptions?.queuedDeliveryCorrelations?.at(-1)?.begin();
        }
        return createNoQueuedDispatchResult();
      });
      await runDraft({ discordConfig: { streaming: { mode: "off" } } });
      const options = getLastDispatchReplyOptions();
      if (!startsBeforeReturn) {
        endQueuedRoute = options?.queuedDeliveryCorrelations?.at(-1)?.begin();
      }
      const sessionKey = String(firstDispatchParams().ctx?.SessionKey);
      const reply = (threadId = "thread-queued") =>
        notifyDiscordActiveTurnThreadReplyDelivered({ sessionKey, accountId: "default", threadId });
      try {
        // Creating a thread alone or answering another thread is not a source reply.
        expect(reply()).toBe(false);
        await notifyDiscordActiveTurnThreadCreated({
          sessionKey,
          accountId: "default",
          sourceChannelId: "c1",
          sourceMessageId: "1001",
          threadId: "thread-queued",
        });
        expect(reply("unrelated-thread")).toBe(false);
        expect(reply()).toBe(true);
      } finally {
        endQueuedRoute?.();
      }
      expect(reply()).toBe(false);
    },
  );
});

describe("processDiscordMessage draft streaming reasoning", () => {
  it("hides gated reasoning and replaces public reasoning snapshots", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    mockDispatch(async (params) => {
      await startPreparedTool(params);
      await params?.replyOptions?.onReasoningStream?.({
        text: "Private planning",
        requiresReasoningProgressOptIn: true,
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
      expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\n🛠️ Exec: running\n• done", {
        complete: true,
      });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Checking ",
        isReasoningSnapshot: true,
      });
      await params?.replyOptions?.onReasoningStream?.({
        text: "Reading \n\nChecking ",
        isReasoningSnapshot: true,
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });
    await runProgressScenario({ toolProgress: true, label: "Clawing..." });

    expect(draftStream.update.mock.calls.at(-1)?.[0]).toContain("_Reading Checking_");
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("_Checking Reading");
    expect(updates.join("\n")).not.toContain("Private planning");
  });
});

describe("Discord durable commentary delivery", () => {
  it("yields quiet progress to durable commentary without exposing ordinary progress blocks", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    mockDispatch(async (params) => {
      expect(params?.replyOptions?.progressRequiresReply).toBe(true);
      expect(params?.replyOptions?.commentaryPayloadsEnabled).toBe(true);
      await params?.replyOptions?.onVerboseProgressVisibilityAsync?.(async () => true);
      expect(params?.replyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(true);
      await params?.replyOptions?.onItemEvent?.({
        itemId: "durable-commentary",
        kind: "preamble",
        phase: "end",
        progressText: "Checking the source before asking.",
      });
      await params?.replyOptions?.onNarrationUpdate?.({
        text: "Narration belongs to the verbose owner.",
      });
      await startToolProgress(params);
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendBlockReply({ text: "ordinary interim text" });
      await params?.dispatcher.sendBlockReply({
        text: "Checking the source before asking.",
        isCommentary: true,
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 1 } };
    });
    await runProgressScenario({ toolProgress: false, label: false, commentary: true });

    expect(deliverDiscordReply).toHaveBeenCalledTimes(2);
    expect(deliverDiscordReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "Checking the source before asking.", isCommentary: true }],
      }),
    );
    expectFreshFinalText("done");
    expect(draftStream.update).not.toHaveBeenCalled();
  });
});
