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
  deliverDiscordReply,
  dispatchBufferedReplyForTest,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
  runInPartialStreamMode,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import {
  createAutomaticDraftContext,
  createMockDraftStreamForTest,
  getDeliveredFinalTexts,
  useProgressDraftStartDelay,
  createBlockModeContext,
  expectFinalAnswerText,
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
    expect(draftStream.update).toHaveBeenLastCalledWith(
      "Investigating\n\n🛠️ Checked the pipeline.",
    );
    expect(draftStream.messageId()).toBeDefined();
    expect(deliverDiscordReply).not.toHaveBeenCalled();
  });

  it("keeps the latest commentary headline above the preserved commentary timeline", async () => {
    const draftStream = createMockDraftStreamForTest();

    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await startToolProgress(params);
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

    const ctx = await createAutomaticDraftContext({
      discordConfig: {
        streaming: {
          mode: "progress",
          progress: {
            label: false,
            toolProgress: false,
            commentary: true,
          },
        },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(draftStream.update).toHaveBeenLastCalledWith(
      "Checking route impacts.\n\n💬 Checking the current weather source before summarizing clearly.\n💬 Checking route impacts.",
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

    expect(draftStream.update).toHaveBeenCalledExactlyOnceWith("Clawing...\n\n🩹 Apply Patch", {
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

    expect(draftStream.update).toHaveBeenCalledWith("Clawing...\n\n🛠️ Exec: running\n• done", {
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
      params?.replyOptions?.onVerboseProgressVisibility?.(() => true);
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
