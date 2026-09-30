import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
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
      "Reading the gateway config and restarting agents.\n\n🛠️ Exec: running",
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

  it("suppresses terminal progress callbacks without their terminal phase", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onApprovalEvent?.({ command: "must stay hidden" });
      await params?.replyOptions?.onCommandOutput?.({ title: "must stay hidden", exitCode: 0 });
      await params?.replyOptions?.onPatchSummary?.({ summary: "must stay hidden" });
      return createNoQueuedDispatchResult();
    });

    const ctx = await createAutomaticDraftContext({
      discordConfig: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).not.toHaveBeenCalled();
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

  it("retains draft previews after error finals are delivered", async () => {
    const draftStream = await runFinalReplyScenario({
      text: "Something failed",
      isError: true,
    } as never);

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
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
