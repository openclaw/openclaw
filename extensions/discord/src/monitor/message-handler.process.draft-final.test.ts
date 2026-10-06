import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ReplyDispatchRuntimeInfo, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  notifyDiscordActiveTurnThreadCreated,
  notifyDiscordActiveTurnThreadReplyDelivered,
} from "../active-turn-thread-route.js";
import {
  BASE_CHANNEL_ROUTE,
  createBaseContext,
  createDiscordDraftStream,
  createMockDraftStream,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  getGlobalHookRunnerForTest as getGlobalHookRunner,
  getLastDispatchReplyOptions,
  getSessionEntry,
  readLatestAssistantTextByIdentity,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
  createNonTerminalToolWarningPayload,
  createDirectMessageContextOverrides,
  dispatchBufferedReplyForTest,
  runInPartialStreamMode,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createAutomaticDraftContext,
  createMockDraftStreamForTest,
  expectFinalAnswerText,
  expectFreshFinalText,
  firstMockArg,
  getDeliveredFinalTexts,
  runSingleChunkFinalScenario,
  useProgressDraftStartDelay,
  createBlockModeContext,
  firstDispatchParams,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();
async function startPreparedTool(
  params: DispatchInboundParams | undefined,
  toolCallId = "exec-1",
  name = "exec",
) {
  const tool = { toolCallId, name, phase: "start" as const };
  await params?.replyOptions?.onItemEvent?.(projectAgentToolActivity(tool));
  await params?.replyOptions?.onToolStart?.(tool);
}

function registerHooks(...hooks: string[]) {
  const registered = new Set(hooks);
  getGlobalHookRunner.mockReturnValue({
    hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
  });
}

async function runHookSafetyFinalReply(mode: "partial" | "progress") {
  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.dispatcher.sendFinalReply({ text: "final answer" });
    await params?.dispatcher.waitForIdle();
    return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
  });
  const ctx = await createAutomaticDraftContext({
    discordConfig: { streaming: { mode } },
  });
  await runProcessDiscordMessage(ctx);
}

describe("processDiscordMessage provider preview hook safety", () => {
  it.each(["reply_payload_sending"])("suppresses previews for %s hooks", async (hookName) => {
    registerHooks(hookName);

    await runHookSafetyFinalReply("partial");

    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("does not re-enter final delivery after message_sending cancellation", async () => {
    registerHooks("message_sending");
    deliverDiscordReply.mockResolvedValueOnce({ visibleReplySent: false });

    await runHookSafetyFinalReply("partial");

    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });
});

describe("processDiscordMessage draft streaming final delivery", () => {
  it("preserves a delivered final when its first stale-preview cleanup fails", async () => {
    registerHooks("message_sent");
    const draftStream = createMockDraftStream();
    draftStream.clear.mockRejectedValueOnce(new Error("preview cleanup failed"));
    createDiscordDraftStream.mockReturnValueOnce(draftStream);
    const runtimeError = vi.fn();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
      runtime: { log: vi.fn(), error: runtimeError },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(2);
    expect(runtimeError).not.toHaveBeenCalled();
    expectFreshFinalText("Hello\nWorld");
  });

  it("sends a fresh final message for broadcast mentions like @everyone", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "heads up @everyone" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      allowedMentions: { parse: ["users", "roles"] },
      onPlatformSendDispatch: expect.any(Function),
    });
  });

  it("keeps unset Discord preview streaming off and delivers the final normally", async () => {
    await runSingleChunkFinalScenario({ maxLinesPerMessage: 5 });
    expect(getLastDispatchReplyOptions()?.onPartialReply).toBeUndefined();
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFreshFinalText("Hello\nWorld");
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
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startPreparedTool(params);
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
      await lookupStarted.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      transcript.resolve(undefined);
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true } },
        maxLinesPerMessage: 5,
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
    expectFreshFinalText(truncatedFinal);
    expect(getDeliveredFinalTexts()[0]).not.toContain("\n-# ");
  });

  it("renders narration updates into the Discord progress draft", async () => {
    vi.useFakeTimers();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
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
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true } },
        maxLinesPerMessage: 5,
      },
    });

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toContain(
      "Reading the gateway config and restarting agents.\n\n• Exec: running",
    );
    expectFinalAnswerText("done");
  });

  it("stops narration at final and resets it for a queued turn", async () => {
    createMockDraftStreamForTest();
    const beginTurn = vi.fn();
    const stopTurn = vi.fn();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      params?.replyOptions?.onProgressNarratorLifecycle?.({ beginTurn, stopTurn });
      await params?.dispatcher.sendFinalReply({ text: "primary" });
      expect(stopTurn).toHaveBeenCalled();

      await params?.replyOptions?.onAssistantMessageStart?.();
      expect(beginTurn).toHaveBeenCalledOnce();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });
    await runProcessDiscordMessage(ctx);
  });

  it("retires coding-profile guild progress only after a confirmed message-tool reply", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
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

    const ctx = await createBaseContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true },
        },
      },
      cfg: {
        channels: {
          discord: {
            streaming: {
              mode: "progress",
              progress: { toolProgress: true },
            },
          },
        },
        tools: { profile: "coding" },
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(draftStream.update).toHaveBeenCalledWith("Working\n\n• Exec: running\n• exec done", {
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
  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.dispatcher.sendFinalReply(payload);
    return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
  });

  const ctx = await createAutomaticDraftContext({
    discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    ...overrides,
  });
  await runProcessDiscordMessage(ctx);
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
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startPreparedTool(params);
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: truncatedFinal });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true } },
        maxLinesPerMessage: 120,
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFinalAnswerText(fullAnswer);
  });

  it("retains the last partial draft when final delivery fails before completion", async () => {
    const draftStream = createMockDraftStreamForTest();
    deliverDiscordReply.mockRejectedValueOnce(new Error("send failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "partial answer..." });
      await params?.dispatcher.sendFinalReply({ text: "complete\nanswer" });
      return {
        queuedFinal: true,
        counts: { final: 1, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 1 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenCalledWith("partial answer...");
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(draftStream.messageId()).toBeDefined();
  });

  it("sends a fresh visible TTS supplement final and clears the preview", async () => {
    const draftStream = await runFinalReplyScenario(
      {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      { replyToMode: "first" },
    );

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.messageId()).toBeUndefined();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replyToId: "1001",
      replies: [
        {
          text: "Spoken answer",
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        },
      ],
    });
  });

  it("keeps already-delivered TTS supplement fallback audio-only", async () => {
    await runFinalReplyScenario({
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: {
        spokenText: "Spoken answer",
        visibleTextAlreadyDelivered: true,
      },
    } as never);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [
        {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: {
            spokenText: "Spoken answer",
            visibleTextAlreadyDelivered: true,
          },
        },
      ],
    });
  });

  it("drops earlier tool warning finals when recovered replies arrive", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      await params?.dispatcher.sendFinalReply({ text: "delivery recovered" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expectFreshFinalText("delivery recovered");
    expect(draftStream.messageId()).toBeUndefined();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
  });

  it("suppresses pure tool warning finals when no recovered reply is available", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "partial" }, maxLinesPerMessage: 5 },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("suppresses tool warning finals when the recovered reply fails to send", async () => {
    deliverDiscordReply.mockRejectedValueOnce(new Error("send failed"));
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({ text: "delivery failed" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return {
        queuedFinal: true,
        counts: { final: 2, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "off" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "delivery failed" }],
    });
  });

  it("renders reasoning-tagged final payloads as a 🧠 blockquote, never the final", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendFinalReply({
        text: "Reasoning:\nthis renders as a quoted thinking message",
        isReasoning: true,
      });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "off" } },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expect(firstMockArg(deliverDiscordReply, "deliverDiscordReply")).toMatchObject({
      replies: [{ text: "> 🧠 this renders as a quoted thinking message" }],
    });
  });

  it("streams block previews using draft chunking", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "HelloWorld" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext();

    await runProcessDiscordMessage(ctx);

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["Hello", "HelloWorld"]);
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
  const ctx = await createAutomaticDraftContext({
    discordConfig: { streaming: { mode: "progress", progress } },
  });
  await runProcessDiscordMessage(ctx);
}

describe("processDiscordMessage draft streaming progress", () => {
  it.each([
    { accepted: true, direct: false },
    { accepted: false, direct: false },
    { accepted: true, direct: true },
  ])(
    "replaces the waiting final only when core accepts its route (accepted: $accepted, direct: $direct)",
    async ({ accepted, direct }) => {
      const draftStream = createMockDraftStreamForTest();
      const adopt = vi.fn<NonNullable<ReplyDispatchRuntimeInfo["adoptProgressContinuation"]>>(
        async (receipt) =>
          accepted &&
          receipt.accountId === "default" &&
          receipt.to === (direct ? "user:U1" : "channel:c1"),
      );
      dispatchBufferedReplyForTest.mockImplementationOnce(async (params) => {
        await params.replyOptions?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Verify the child result", status: "in_progress" }],
        });
        const payload = { text: "Waiting for the child result." };
        // Core adds the capability after beforeDeliver has frozen the parent draft.
        await params.dispatcherOptions.beforeDeliver?.(payload, { kind: "final" });
        await params.dispatcherOptions.deliver(payload, {
          kind: "final",
          adoptProgressContinuation: adopt,
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "late-parent",
          kind: "preamble",
          progressText: "Late parent text must not replace the transferred card.",
        });
        return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
      });
      const ctx = await createAutomaticDraftContext({
        ...(direct ? createDirectMessageContextOverrides() : {}),
        discordConfig: {
          streaming: { mode: "progress", progress: { label: false, toolProgress: true } },
        },
      });

      await runProcessDiscordMessage(ctx);

      expect(adopt).toHaveBeenCalledOnce();
      expect(getDeliveredFinalTexts()).toEqual(accepted ? [] : ["Waiting for the child result."]);
      expect(draftStream.messageId()).toBeUndefined();
      expect(draftStream.update.mock.calls.flat().join("\n")).not.toContain("Late parent text");
    },
  );

  it.each([
    { text: "Child attachment", mediaUrl: "https://example.com/result.png" },
    {
      text: "Choose the next step",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Continue", action: { type: "callback", value: "continue" } }],
          },
        ],
      },
    },
  ] satisfies ReplyPayload[])(
    "preserves waiting-final content outside the card: $text",
    async (payload) => {
      createMockDraftStreamForTest();
      const adopt = vi.fn(async () => true);
      dispatchBufferedReplyForTest.mockImplementationOnce(async (params) => {
        await params.replyOptions?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Run child work", status: "in_progress" }],
        });
        await params.dispatcherOptions.beforeDeliver?.(payload, { kind: "final" });
        await params.dispatcherOptions.deliver(payload, {
          kind: "final",
          adoptProgressContinuation: adopt,
        });
        return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
      });
      const ctx = await createAutomaticDraftContext({
        discordConfig: { streaming: { mode: "progress", progress: { toolProgress: true } } },
      });

      await runProcessDiscordMessage(ctx);

      expect(adopt).not.toHaveBeenCalled();
      expect(getDeliveredFinalTexts()).toEqual([payload.text]);
      expect(deliverDiscordReply).toHaveBeenCalledWith(
        expect.objectContaining({ replies: [payload] }),
      );
    },
  );

  it("moves progress and final delivery into a thread created from the source message", async () => {
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
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
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });
    await runProgressScenario({ toolProgress: true });

    expect(draftStream.retarget).toHaveBeenCalledWith("thread-1");
    expect(deliverDiscordReply).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "channel:thread-1",
        replyToId: undefined,
      }),
    );
  });

  it("keeps adopted-thread progress with terminal tool and timing receipts", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
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
    expect(draftStream.update).toHaveBeenLastCalledWith("Investigating\n\n• Checked the pipeline.");
    expect(draftStream.messageId()).toBeDefined();
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("retries an unacknowledged preamble and reports visibility after Discord accepts it", async () => {
    const draftStream = createMockDraftStreamForTest();
    draftStream.messageId.mockReturnValue(undefined);
    const results: Array<boolean | void> = [];

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      const preamble = {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking source data.",
      };
      results.push(await params?.replyOptions?.onItemEvent?.(preamble));
      draftStream.messageId.mockReturnValue("preview-1");
      results.push(await params?.replyOptions?.onItemEvent?.(preamble));
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({ toolProgress: true, label: false, commentary: true });

    expect(results).toEqual([false, true]);
    expect(draftStream.update.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps tool rows while yielding commentary to the durable verbose lane", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onVerboseProgressVisibilityAsync?.(async () => true);
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing.",
      });
      await startToolProgress(params);
      await params?.replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        exitCode: 0,
      });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({ toolProgress: true, label: "Shelling", commentary: true });

    const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
    expect(updates).toContain("Exec");
    expect(updates).not.toContain("Checking the current weather source");
  });

  it("re-arms progress collapse for a queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
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

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      replyOptions = params?.replyOptions;
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    await runProcessDiscordMessage(ctx);

    await replyOptions?.onQueuedFollowupAdmitted?.();
    await replyOptions?.onToolStart?.({ name: "view_image", phase: "start" });
    await replyOptions?.onItemEvent?.({ progressText: "viewing image" });
    await elapseProgressDraftStartDelay();
    expect(draftStream.messageId()).toBeDefined();

    await replyOptions?.onQueuedFollowupSettled?.();

    expect(draftStream.messageId()).toBeUndefined();
  });
});

describe("processDiscordMessage draft streaming reasoning", () => {
  it("keeps one prepared Apply Patch row when the raw summary arrives", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startPreparedTool(params, "patch-1", "apply_patch");
      await params?.replyOptions?.onPatchSummary?.({
        toolCallId: "patch-1",
        phase: "end",
        name: "apply_patch",
        summary: "1 modified",
        modified: ["extensions/discord/src/monitor/message-handler.draft-preview.ts"],
      });
      await params?.replyOptions?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "patch-1",
          name: "apply_patch",
          phase: "result",
          status: "completed",
          result: {
            details: {
              summary: {
                added: [],
                modified: ["extensions/discord/src/monitor/message-handler.draft-preview.ts"],
                deleted: [],
              },
            },
          },
        }),
      );
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({ toolProgress: true, label: "Clawing..." });

    expect(draftStream.update).toHaveBeenCalledExactlyOnceWith("Clawing...\n\n• Apply Patch", {
      complete: true,
    });
  });

  it("hides opt-in reasoning while session reasoning streaming is off", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startPreparedTool(params);
      await params?.replyOptions?.onReasoningStream?.({
        text: "Private planning",
        requiresReasoningProgressOptIn: true,
      });
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({ toolProgress: true, label: "Clawing..." });

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\n• Exec: running\n• done", {
      complete: true,
    });
    expect(draftStream.update.mock.calls.map((call) => call[0]).join("\n")).not.toContain(
      "Private planning",
    );
  });

  it("replaces reasoning snapshots instead of appending duplicates", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startPreparedTool(params);
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
  });

  it("forces new preview messages on assistant boundaries in block mode", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params?.replyOptions?.onAssistantMessageStart?.();
      return createNoQueuedDispatchResult();
    });

    const ctx = await createBlockModeContext();

    await runProcessDiscordMessage(ctx);

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
  });

  it("skips pure-reasoning partial updates without updating draft", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onPartialReply?.({
        text: "Reasoning:\nThe user asked about X so I need to consider Y",
      });
      return createNoQueuedDispatchResult();
    });

    await runInPartialStreamMode();

    expect(draftStream.update).not.toHaveBeenCalled();
  });
});

describe("Discord durable commentary delivery", () => {
  it("delivers admitted commentary once without exposing ordinary progress blocks", async () => {
    createMockDraftStreamForTest();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onVerboseProgressVisibilityAsync?.(async () => true);
      await params?.dispatcher.sendBlockReply({ text: "ordinary interim text" });
      await params?.dispatcher.sendBlockReply({
        text: "Checking the source before asking.",
        isCommentary: true,
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 1 } };
    });
    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: false, commentary: true },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(deliverDiscordReply).toHaveBeenCalledTimes(2);
    expect(deliverDiscordReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "Checking the source before asking.", isCommentary: true }],
      }),
    );
    expectFinalAnswerText("done");
  });
});
