import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

type DraftStream = ReturnType<typeof import("./draft-stream.js").createMattermostDraftStream>;
type ReplyOptions = Parameters<typeof dispatchInboundMessage>[0]["replyOptions"];

function createFinalDraft<T extends Partial<Omit<DraftStream, "deleteCurrentMessage">>>(
  overrides: T,
) {
  return {
    update: vi.fn(),
    updateAssistantText: vi.fn(),
    forceNewMessage: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    postId: vi.fn(() => undefined),
    clear: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    settleBoundaries: vi.fn(async () => {}),
    resolveFinalText: (text: string): ReturnType<DraftStream["resolveFinalText"]> => ({
      kind: "full",
      text,
      publishedParts: [],
    }),
    ...overrides,
  };
}

export function registerMattermostPreviewDeliveryTests(harness: {
  testConfig: OpenClawConfig;
  createRuntimeCore: (config: OpenClawConfig) => unknown;
  receivePost: (
    post: { id: string; message: string; rootId?: string },
    config: OpenClawConfig,
  ) => Promise<unknown>;
  mockState: {
    runtimeCore: unknown;
    abortController: AbortController | undefined;
    createMattermostDraftStream: Mock;
    dispatchInboundMessage: Mock;
    createReplyDispatcherWithTyping: Mock;
    sendMessageMattermost: Mock;
    updateMattermostPost: Mock;
    recordMattermostThreadParticipation: Mock;
    progressDrafts: Array<{ getSnapshot: () => { lines: readonly unknown[] } }>;
  };
}) {
  const { testConfig, createRuntimeCore, receivePost, mockState } = harness;
  const withStreaming = (
    streaming: NonNullable<
      NonNullable<NonNullable<OpenClawConfig["channels"]>["mattermost"]>["streaming"]
    >,
    responsePrefix?: string,
  ): OpenClawConfig => ({
    channels: { mattermost: { ...testConfig.channels?.mattermost, streaming, responsePrefix } },
  });
  const dispatcher = () =>
    mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
  const expectParticipation = (root: string) => {
    const expected = ["default", "chan-1", root];
    expect(mockState.recordMattermostThreadParticipation.mock.calls).toContainEqual(expected);
  };
  const run = async (
    config: OpenClawConfig,
    dispatch: (reply: ReplyOptions) => Promise<void>,
    rootId?: string,
    cleanup?: () => void,
  ) => {
    mockState.runtimeCore = createRuntimeCore(config);
    mockState.dispatchInboundMessage.mockImplementation(
      async ({ replyOptions }: Parameters<typeof dispatchInboundMessage>[0]) => {
        try {
          await dispatch(replyOptions);
        } finally {
          cleanup?.();
          mockState.abortController?.abort();
        }
      },
    );
    await receivePost({ id: "preview-input", message: "stream", rootId }, config);
  };
  it("preserves text-tool-text boundaries while grouping interleaved tool updates", async () => {
    const blockConfig = withStreaming({
      mode: "block",
      preview: { toolProgress: true, commandText: "raw" },
    });
    const draftUpdate = vi.fn();
    const forceNewMessage = vi.fn(async () => {});
    const toolBoundary = createDeferred<void>();
    const assistantBoundaryGate = createDeferred<void>();
    const finalBoundary = createDeferred<void>();
    let assistantBoundarySettled = false;
    forceNewMessage.mockImplementation(async () => {
      const callNumber = forceNewMessage.mock.calls.length;
      if (callNumber === 1) {
        await toolBoundary.promise;
        return;
      }
      if (callNumber === 2) {
        await assistantBoundaryGate.promise;
        assistantBoundarySettled = true;
        return;
      }
      if (callNumber === 5) {
        await finalBoundary.promise;
      }
    });
    mockState.createMattermostDraftStream.mockReturnValue(
      createFinalDraft({
        update: draftUpdate,
        updateAssistantText: draftUpdate,
        forceNewMessage,
      }),
    );

    const lastDraft = () => String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");
    await run(
      blockConfig,
      async (reply) => {
        const toolEvent = (
          toolCallId: string,
          command: string,
          phase: "start" | "update" = "start",
        ) => {
          const event = { toolCallId, name: "bash", phase, args: { command } };
          const pending = reply?.onItemEvent?.(projectAgentToolActivity(event));
          void reply?.onToolStart?.({ ...event, detailMode: "raw" });
          return pending;
        };
        await reply?.onAssistantMessageStart?.();
        reply?.onPartialReply?.({ text: "A much longer first block" });
        const firstToolStart = toolEvent("bash-1", "ls");
        const secondToolStart = toolEvent("bash-2", "pwd");
        const firstToolUpdate = toolEvent("bash-1", "ls -alh", "update");
        reply?.onAssistantMessageStart?.();
        await reply?.onReasoningEnd?.();
        const consecutiveToolStart = toolEvent("bash-3", "whoami");
        for (const command of ["pwd", "ls -alh", "whoami"]) {
          expect(lastDraft()).toContain(command);
        }

        reply?.onAssistantMessageStart?.();
        const assistantBoundary = reply?.onPartialReply?.({ text: "Done." });
        expect(assistantBoundarySettled).toBe(false);
        expect(lastDraft()).toBe("Done.");
        toolBoundary.resolve();
        assistantBoundaryGate.resolve();
        await Promise.all([
          firstToolStart,
          secondToolStart,
          firstToolUpdate,
          consecutiveToolStart,
          assistantBoundary,
        ]);
        reply?.onAssistantMessageStart?.();
        await reply?.onReasoningStream?.({ text: "Private chain of thought" });
        expect(lastDraft()).toBe("Thinking…");
        await reply?.onReasoningEnd?.();
        reply?.onAssistantMessageStart?.();
        await reply?.onReasoningStream?.({ text: "Second reasoning item" });
        reply?.onAssistantMessageStart?.();
        await reply?.onPartialReply?.({ text: "Answer after reasoning" });
        reply?.onAssistantMessageStart?.();
        const finalEvent = {
          toolCallId: "bash-final",
          name: "bash",
          phase: "start" as const,
          args: { command: "date" },
        };
        await reply?.onItemEvent?.(projectAgentToolActivity(finalEvent));
        await reply?.onToolStart?.({ ...finalEvent, detailMode: "raw" });
        expect(lastDraft()).toContain("date");
        const finalDelivery = dispatcher()?.deliver(
          { text: "Final without a partial" },
          { kind: "final" },
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
        finalBoundary.resolve();
        await finalDelivery;
      },
      undefined,
      () => {
        toolBoundary.resolve();
        assistantBoundaryGate.resolve();
        finalBoundary.resolve();
      },
    );

    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "Final without a partial",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(draftUpdate).toHaveBeenNthCalledWith(1, "A much longer first block");
    expect(draftUpdate).toHaveBeenCalledWith("Answer after reasoning");
  });

  it("keeps Mattermost progress with tools disabled and no label", async () => {
    let previewPostId: string | undefined = "preview-progress";
    let visiblePreviewText: string | undefined;
    const draftStream = {
      update: vi.fn((text: string) => {
        visiblePreviewText = text;
      }),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => previewPostId),
      clear: vi.fn(async () => {
        previewPostId = undefined;
        visiblePreviewText = undefined;
      }),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      deleteCurrentMessage: vi.fn(async () => {}),
      forceNewMessage: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    mockState.createMattermostDraftStream.mockReturnValue(draftStream);
    const progressConfig = withStreaming({
      mode: "progress",
      progress: { label: false, toolProgress: false },
    });
    await run(progressConfig, async (reply) => {
      const startTool = async (toolCallId: string, name: string) => {
        const event = { toolCallId, name, phase: "start" as const };
        await reply?.onItemEvent?.(projectAgentToolActivity(event));
        await reply?.onToolStart?.(event);
      };
      const step = (name: string, status: "in_progress" | "completed" = "in_progress") => ({
        step: name,
        status,
      });
      const plan = (steps: ReturnType<typeof step>[] = [], explanation?: string) =>
        reply?.onPlanUpdate?.({ phase: "update", steps, ...(explanation ? { explanation } : {}) });
      const tool = (
        itemId: string,
        name: string,
        status: "completed" | "failed" | "running",
        progressText?: string,
      ) =>
        reply?.onItemEvent?.({
          itemId,
          kind: "tool",
          name,
          status,
          ...(progressText ? { progressText } : {}),
        });
      await plan([step("Inspect")]);
      await plan();
      expect(draftStream.deleteCurrentMessage).toHaveBeenCalledTimes(1);
      await plan([step("Resume")]);
      reply?.onAssistantMessageStart?.();
      await reply?.onItemEvent?.({
        itemId: "card-rejected",
        kind: "tool",
        name: "progress_card",
        phase: "end",
        status: "blocked",
      });
      reply?.onAssistantMessageStart?.();
      await startTool("exec-boundary", "exec");
      const resumedProgress = draftStream.update.mock.calls.at(-1)?.[0];
      expect(resumedProgress).toContain("▸ Resume");
      expect(resumedProgress).not.toMatch(/blocked|Exec/);
      reply?.onAssistantMessageStart?.();
      await plan();
      expect(draftStream.deleteCurrentMessage).toHaveBeenCalledTimes(2);
      await startTool("read-1", "read");
      reply?.onAssistantMessageStart?.();
      reply?.onReasoningEnd?.();
      await startTool("exec-1", "exec");
      await tool("tool:read-1", "read", "completed", "done");
      await reply?.onReasoningStream?.({ text: "Thinking" });
      await reply?.onReasoningEnd?.();
      await reply?.onReasoningStream?.({ text: "Checking" });
      await tool("tool:read-1", "read", "completed", "done");
      await tool("tool:failed-1", "exec", "failed");
      await plan([step("Inspect", "completed"), step("Patch")], "1/2 complete");
      await plan([], "Progress updated");
      await plan();
      await reply?.onObservedReplyDelivery?.();
      await tool("tool:late", "exec", "running", "late progress");
      expect(previewPostId).toBeUndefined();
      expect(visiblePreviewText).toBeUndefined();
    });
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    const updates = draftStream.update.mock.calls.map((call) => call[0]);
    expect(updates[0]).toBe("▸ Inspect");
    expect(updates.at(-1)).not.toMatch(/Read|done|ThinkingChecking/);
    expect(updates.join("\n")).not.toContain("failed");
    expect(updates.at(-1)).toContain("Checking");
    expect(updates.some((text) => text.includes("1/2 complete"))).toBe(true);
    expect(updates.some((text) => text.includes("✅ Inspect"))).toBe(true);
    expect(updates.some((text) => text.includes("▸ Patch"))).toBe(true);
    expect(updates.some((text) => text.includes("Progress updated"))).toBe(true);
    expect(updates.join("\n")).not.toContain("<progress");
  });

  it("finalizes only the current block when the terminal reply is cumulative", async () => {
    const blockConfig = withStreaming({ mode: "block" }, "[bot]");
    mockState.updateMattermostPost.mockRejectedValueOnce(new Error("edit failed"));
    const forceNewMessage = vi.fn(async () => {});
    const updateAssistantText = vi.fn();
    const resolveFinalText = vi.fn((text: string) =>
      text === "[bot] First block\n\nSecond block"
        ? { kind: "remaining" as const, text: "Second block", publishedParts: [] }
        : { kind: "full" as const, text, publishedParts: [] },
    );
    mockState.createMattermostDraftStream.mockReturnValue(
      createFinalDraft({
        updateAssistantText,
        forceNewMessage,
        postId: vi.fn(() => "preview-current"),
        resolveFinalText,
      }),
    );

    await run(blockConfig, async (reply) => {
      await reply?.onAssistantMessageStart?.();
      await reply?.onPartialReply?.({ text: "First block" });
      await reply?.onAssistantMessageStart?.();
      await reply?.onPartialReply?.({ text: "Second block" });
      await dispatcher()?.deliver({ text: "[bot] First block\n\nSecond block" }, { kind: "final" });
    });
    expect(forceNewMessage).toHaveBeenCalledTimes(1);
    expect(updateAssistantText).toHaveBeenNthCalledWith(1, "[bot] First block");
    expect(updateAssistantText).toHaveBeenNthCalledWith(2, "Second block");
    expect(mockState.updateMattermostPost).toHaveBeenCalledWith({}, "preview-current", {
      message: "Second block",
    });
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "Second block",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("records confirmed-preview participation when cleanup fails", async () => {
    const blockConfig = withStreaming({ mode: "block" });
    const discardPending = vi.fn(async () => {
      throw new Error("preview cleanup failed");
    });
    mockState.createMattermostDraftStream.mockReturnValue(
      createFinalDraft({
        discardPending,
        resolveFinalText: vi.fn(() => ({
          kind: "already-delivered" as const,
          publishedParts: [{ messageId: "preview-sealed", content: "Only block" }],
        })),
      }),
    );
    await run(
      blockConfig,
      async (reply) => {
        await reply?.onAssistantMessageStart?.();
        await reply?.onPartialReply?.({ text: "Only block" });
        await reply?.onAssistantMessageStart?.();
        await expect(
          dispatcher()?.deliver({ text: "Only block" }, { kind: "final" }),
        ).resolves.toMatchObject({
          visibleReplySent: true,
          messageIds: ["preview-sealed"],
        });
      },
      "confirmed-root",
    );
    expect(discardPending).toHaveBeenCalled();
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    expectParticipation("confirmed-root");
  });

  it("records participation when a later send step fails after a visible thread post", async () => {
    const progressConfig = withStreaming({ mode: "progress", progress: { toolProgress: true } });
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "partial-post-1", channelId: "chan-1" }],
      kind: "text",
      replyToId: "partial-root",
    });
    mockState.sendMessageMattermost.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("bookkeeping failed"), {
        messageIds: ["partial-post-1"],
        receipt,
        visibleReplySent: true,
        content: "Visible partial reply",
      }),
    );
    mockState.createMattermostDraftStream.mockReturnValue(createFinalDraft({}));
    await run(
      progressConfig,
      async (reply) => {
        await expect(
          dispatcher()?.deliver({ text: "Visible partial reply" }, { kind: "final" }),
        ).rejects.toThrow("bookkeeping failed");
        await reply?.onReasoningStream?.({ text: "late reasoning" });
      },
      "partial-root",
    );
    expectParticipation("partial-root");
    expect(mockState.progressDrafts.at(-1)?.getSnapshot().lines).toEqual([]);
  });
}
