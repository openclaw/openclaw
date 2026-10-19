import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig, ReplyPayload } from "./runtime-api.js";

type DraftStream = ReturnType<typeof import("./draft-stream.js").createMattermostDraftStream>;

export function createFinalDraft<T extends Partial<Omit<DraftStream, "deleteCurrentMessage">>>(
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
    const expected = ["default", "chan-1", root, { agentId: "main" }];
    expect(mockState.recordMattermostThreadParticipation.mock.calls).toContainEqual(expected);
  };
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
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    let firstPlanRetractionDeletes = 0;
    let resumedProgress: string | undefined;
    let secondPlanRetractionDeletes = 0;
    mockState.dispatchInboundMessage.mockImplementation(async ({ replyOptions: reply }) => {
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
      firstPlanRetractionDeletes = draftStream.deleteCurrentMessage.mock.calls.length;
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
      resumedProgress = draftStream.update.mock.calls.at(-1)?.[0];
      reply?.onAssistantMessageStart?.();
      await plan();
      secondPlanRetractionDeletes = draftStream.deleteCurrentMessage.mock.calls.length;
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
      mockState.abortController?.abort();
    });
    await receivePost({ id: "post-progress", message: "run this" }, progressConfig);
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    expect(firstPlanRetractionDeletes).toBe(1);
    expect(resumedProgress).toContain("▸ Resume");
    expect(resumedProgress).not.toMatch(/blocked|Exec/);
    expect(secondPlanRetractionDeletes).toBe(2);
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
    mockState.runtimeCore = createRuntimeCore(blockConfig);
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

    mockState.dispatchInboundMessage.mockImplementation(async ({ replyOptions: reply }) => {
      await reply?.onAssistantMessageStart?.();
      await reply?.onPartialReply?.({ text: "First block" });
      await reply?.onAssistantMessageStart?.();
      await reply?.onPartialReply?.({ text: "Second block" });
      await dispatcher()?.deliver({ text: "[bot] First block\n\nSecond block" }, { kind: "final" });
      mockState.abortController?.abort();
    });
    await receivePost({ id: "post-cumulative-final", message: "stream two blocks" }, blockConfig);
    expect(forceNewMessage).toHaveBeenCalledTimes(1);
    expect(updateAssistantText).toHaveBeenNthCalledWith(1, "[bot] First block");
    expect(updateAssistantText).toHaveBeenNthCalledWith(2, "Second block");
    expect(resolveFinalText).toHaveBeenCalledWith("[bot] First block\n\nSecond block");
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
    mockState.runtimeCore = createRuntimeCore(blockConfig);
    mockState.createMattermostDraftStream.mockReturnValue(
      createFinalDraft({
        discardPending: vi.fn(async () => {
          throw new Error("preview cleanup failed");
        }),
        resolveFinalText: vi.fn(() => ({
          kind: "already-delivered" as const,
          publishedParts: [{ messageId: "preview-sealed", content: "Only block" }],
        })),
      }),
    );
    mockState.dispatchInboundMessage.mockImplementation(async ({ replyOptions: reply }) => {
      try {
        await reply?.onAssistantMessageStart?.();
        await reply?.onPartialReply?.({ text: "Only block" });
        await reply?.onAssistantMessageStart?.();
        await expect(
          dispatcher()?.deliver({ text: "Only block" }, { kind: "final" }),
        ).rejects.toThrow("preview cleanup failed");
      } finally {
        mockState.abortController?.abort();
      }
    });
    await receivePost(
      { id: "confirmed-preview", message: "stream", rootId: "confirmed-root" },
      blockConfig,
    );
    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    expectParticipation("confirmed-root");
  });

  it("records participation when a later send step fails after a visible thread post", async () => {
    const progressConfig = withStreaming({ mode: "progress", progress: { toolProgress: true } });
    mockState.runtimeCore = createRuntimeCore(progressConfig);
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
    mockState.dispatchInboundMessage.mockImplementation(
      async (dispatchParams: {
        replyOptions?: {
          onReasoningStream?: (payload: ReplyPayload) => void | Promise<void>;
        };
      }) => {
        try {
          await expect(
            dispatcher()?.deliver({ text: "Visible partial reply" }, { kind: "final" }),
          ).rejects.toThrow("bookkeeping failed");
          await dispatchParams.replyOptions?.onReasoningStream?.({ text: "late reasoning" });
        } finally {
          mockState.abortController?.abort();
        }
      },
    );

    await receivePost(
      { id: "partial-thread", message: "reply", rootId: "partial-root" },
      progressConfig,
    );
    expectParticipation("partial-root");
    expect(mockState.progressDrafts.at(-1)?.getSnapshot().lines).toEqual([]);
  });
}
