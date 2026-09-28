// Discord message processing coverage split by cohesive behavior.
import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyDispatchRuntimeInfo, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  notifyDiscordActiveTurnThreadCreated,
  notifyDiscordActiveTurnThreadReplyDelivered,
} from "../active-turn-thread-route.js";
import {
  createDirectMessageContextOverrides,
  createNoQueuedDispatchResult,
  createNonTerminalToolWarningPayload,
  deliverDiscordReply,
  dispatchBufferedReplyForTest,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createAutomaticDraftContext,
  createMockDraftStreamForTest,
  expectFinalAnswerText,
  getDeliveredFinalTexts,
  useProgressDraftStartDelay,
} from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

async function startToolProgress(
  params: DispatchInboundParams | undefined,
  name: string,
  args?: Record<string, unknown>,
  meta?: string,
) {
  const tool = { name, toolCallId: `${name}-1`, phase: "start" as const, args };
  await params?.replyOptions?.onToolStart?.(tool);
  await params?.replyOptions?.onItemEvent?.(projectAgentToolActivity({ ...tool, meta }));
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
      await startToolProgress(params, "exec");
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

  it("keeps opt-in commentary receipts independent from hidden tool progress", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params, "exec");
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-silent",
        kind: "preamble",
        progressText: "[[reply_to_current]] _NO_REPLY_ [[audio_as_voice]]",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing clearly.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-2",
        kind: "preamble",
        progressText: "Checking route impacts.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "tool-1",
        kind: "tool",
        name: "exec",
        progressText: "curl weather api",
      });
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    await runProgressScenario({
      label: false,
      toolProgress: false,
      commentary: true,
    });

    expect(draftStream.update).toHaveBeenLastCalledWith(
      "💬 Checking the current weather source before summarizing clearly.\n💬 Checking route impacts.",
      { complete: true },
    );
    const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
    expect(updates).not.toContain("Exec");
    expect(updates).not.toContain("curl weather api");
    expectFinalAnswerText("done");
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

  it.each([
    ["active", true],
    ["inactive", false],
  ])(
    "renders Discord commentary in the draft exactly when durable verbose progress is %s",
    async (_label, durableLaneActive) => {
      const draftStream = createMockDraftStreamForTest();

      dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
        expect(params?.replyOptions?.commentaryPayloadsEnabled).toBe(true);
        expect(params?.replyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(false);
        params?.replyOptions?.onVerboseProgressVisibility?.(() => durableLaneActive);
        expect(params?.replyOptions?.shouldDeliverCommentaryPayloads?.()).toBe(durableLaneActive);
        await params?.replyOptions?.onItemEvent?.({
          itemId: "preamble-1",
          kind: "preamble",
          progressText: "Checking the current weather source before summarizing.",
        });
        return createNoQueuedDispatchResult();
      });

      await runProgressScenario({
        label: false,
        toolProgress: false,
        commentary: true,
      });

      const updates = draftStream.update.mock.calls.map((call) => call[0]).join("\n");
      if (durableLaneActive) {
        // The durable verbose lane owns commentary: the ephemeral draft must
        // not render it a second time.
        expect(updates).toBe("");
      } else {
        expect(updates).toContain("Checking the current weather source");
      }
    },
  );

  it("omits the durable commentary owner when Discord commentary progress is disabled", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      expect(params?.replyOptions?.commentaryPayloadsEnabled).toBe(false);
      expect(params?.replyOptions?.shouldDeliverCommentaryPayloads).toBeUndefined();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({ toolProgress: true, commentary: false });
  });

  it("keeps tool rows while yielding commentary to the durable verbose lane", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      params?.replyOptions?.onVerboseProgressVisibility?.(() => true);
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the current weather source before summarizing.",
      });
      await startToolProgress(params, "exec");
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

  it("retracts a preamble headline by item identity", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Temporary note.",
      });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "",
      });
      await startToolProgress(params, "exec");
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({
      toolProgress: true,
      label: false,
    });

    expect(draftStream.update).toHaveBeenLastCalledWith("🛠️ Exec: running", { complete: true });
    expect(draftStream.update.mock.calls.flat().join("\n")).not.toContain("Temporary note.");
    // Cleanup still removes the unfinished tool-progress draft at run end.
    expect(draftStream.messageId()).toBeUndefined();
  });

  it("does not update Discord commentary progress after final answer delivery starts", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking source data.",
      });
      void params?.dispatcher.sendFinalReply({ text: "done" });
      await params?.replyOptions?.onItemEvent?.({
        itemId: "preamble-2",
        kind: "preamble",
        progressText: "Late commentary should not edit the draft.",
      });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    await runProgressScenario({
      toolProgress: true,
      label: false,
      commentary: true,
    });

    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates).toEqual(["💬 Checking source data."]);
    expectFinalAnswerText("done");
  });

  it("does not start Discord progress drafts for text-only accepted turns", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async () => createNoQueuedDispatchResult());

    await runProgressScenario({
      toolProgress: true,
      label: "Shelling",
    });

    expect(draftStream.update).not.toHaveBeenCalled();
    expect(draftStream.flush).not.toHaveBeenCalled();
  });

  it("keeps Discord progress drafts instead of delivering text-only interim blocks after work expands", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.dispatcher.sendBlockReply({ text: "on it" });
      await startToolProgress(params, "exec");
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "done" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 1 } };
    });

    await runProgressScenario({
      toolProgress: true,
      label: "Shelling",
    });

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec: running\n• exec done", {
      complete: true,
    });
    expectFinalAnswerText("done");
  });

  it("drops later tool warning finals after progress preview final replies", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params, "exec");
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "delivery survived" });
      await params?.dispatcher.waitForIdle();
      await params?.dispatcher.sendFinalReply(createNonTerminalToolWarningPayload());
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    await runProgressScenario({
      toolProgress: true,
      label: "Shelling",
    });

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec: running\n• exec done", {
      complete: true,
    });
    // The delivered final consumed the draft; the later tool warning must not
    // resurrect it or produce a second visible reply.
    expect(draftStream.messageId()).toBeUndefined();
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    expectFinalAnswerText("delivery survived");
  });

  it("clears progress before delivering later final payloads", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params, "exec");
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      expect(draftStream.messageId()).toBeUndefined();
      await params?.dispatcher.sendFinalReply({ text: "second answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    await runProgressScenario({ toolProgress: true, label: "Shelling" });

    expect(draftStream.messageId()).toBeUndefined();
    expect(getDeliveredFinalTexts()).toEqual(["first answer", "second answer"]);
  });

  it("keeps the progress draft uncollapsed when the first final delivery fails", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params, "exec");
      await params?.replyOptions?.onItemEvent?.({ progressText: "exec done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      expect(draftStream.messageId()).toBeDefined();
      expect(draftStream.lastDeliveredText()).toContain("exec done");
      await params?.dispatcher.sendFinalReply({ text: "retry answer" });
      await params?.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: { final: 1, tool: 0, block: 0 },
        failedCounts: { final: 1 },
      };
    });

    await runProgressScenario({ toolProgress: true, label: "Shelling" });

    expect(draftStream.messageId()).toBeUndefined();
    expect(getDeliveredFinalTexts()).toEqual(["first answer", "retry answer"]);
  });

  it("re-arms progress collapse for a queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params, "exec");
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

  it("does not collapse a text-only queued assistant turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params, "exec");
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      expect(draftStream.messageId()).toBeUndefined();
      await params?.replyOptions?.onQueuedFollowupAdmitted?.();
      expect(draftStream.messageId()).toBeUndefined();
      await params?.dispatcher.sendFinalReply({ text: "text-only answer" });
      await params?.dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { final: 2, tool: 0, block: 0 } };
    });

    await runProgressScenario({ toolProgress: true, label: "Shelling" });

    expect(draftStream.messageId()).toBeUndefined();
    expect(getDeliveredFinalTexts()).toEqual(["first answer", "text-only answer"]);
  });

  it("cleans up an unfinished queued progress turn", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params, "exec");
      await params?.replyOptions?.onItemEvent?.({ progressText: "first tool done" });
      await elapseProgressDraftStartDelay();
      await params?.dispatcher.sendFinalReply({ text: "first answer" });
      await params?.dispatcher.waitForIdle();
      await params?.replyOptions?.onQueuedFollowupAdmitted?.();
      await params?.replyOptions?.onToolStart?.({ name: "read", phase: "start" });
      await params?.replyOptions?.onItemEvent?.({ progressText: "queued work" });
      await elapseProgressDraftStartDelay();
      expect(draftStream.messageId()).toBeDefined();
      expect(draftStream.lastDeliveredText()).toContain("queued work");
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    await runProgressScenario({ toolProgress: true, label: "Shelling" });

    expect(getDeliveredFinalTexts()).toEqual(["first answer"]);
    expect(draftStream.messageId()).toBeUndefined();
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

  it("uses raw tool-progress detail in Discord progress drafts", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(
        params,
        "exec",
        { command: "pnpm test -- --watch=false" },
        "run tests, `pnpm test -- --watch=false`",
      );
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({
      toolProgress: true,
      label: "Shelling",
      commandText: "raw",
    });

    expect(draftStream.update).toHaveBeenCalledWith(
      "Shelling\n\n🛠️ run tests, `pnpm test -- --watch=false`\n• done",
      { complete: true },
    );
  });

  it("can hide raw command progress text in Discord progress drafts by config", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(
        params,
        "exec",
        { command: "pnpm test -- --watch=false" },
        "run tests, `pnpm test -- --watch=false`",
      );
      await params?.replyOptions?.onItemEvent?.({ progressText: "done" });
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({
      toolProgress: true,
      label: "Shelling",
      commandText: "status",
    });

    expect(draftStream.update).toHaveBeenCalledWith("Shelling\n\n🛠️ Exec: running\n• done", {
      complete: true,
    });
  });

  it("preserves command output text when raw Discord progress is configured", async () => {
    const elapseProgressDraftStartDelay = useProgressDraftStartDelay();
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
      });
      await params?.replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "pnpm test -- --watch=false",
        name: "exec",
        exitCode: 0,
      });
      await params?.replyOptions?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "exec-1",
          name: "exec",
          phase: "result",
          isError: false,
          args: { command: "pnpm test -- --watch=false" },
          meta: "pnpm test -- --watch=false",
        }),
      );
      await elapseProgressDraftStartDelay();
      return createNoQueuedDispatchResult();
    });

    await runProgressScenario({ toolProgress: true, label: "Shelling", commandText: "raw" });

    expect(draftStream.update.mock.calls.flat().join("\n")).toContain("pnpm test -- --watch=false");
  });
});
