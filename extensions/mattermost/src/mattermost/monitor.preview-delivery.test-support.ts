import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig, ReplyPayload } from "./runtime-api.js";

type DraftStream = ReturnType<typeof import("./draft-stream.js").createMattermostDraftStream>;

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
  it.each([
    { toolProgress: false, mode: "progress" },
    { toolProgress: true, mode: "block" },
  ] as const)(
    "keeps Mattermost $mode progress with tools $toolProgress and no label",
    async ({ toolProgress, mode }) => {
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
      const progressConfig = withStreaming({ mode, progress: { label: false, toolProgress } });
      mockState.runtimeCore = createRuntimeCore(progressConfig);
      let firstPlanRetractionDeletes = 0;
      let resumedProgress: string | undefined;
      let retractedProgress: string | undefined;
      let secondPlanRetractionDeletes = 0;
      mockState.dispatchInboundMessage.mockImplementation(async (params) => {
        await params.replyOptions?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Inspect", status: "in_progress" }],
        });
        await params.replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
        firstPlanRetractionDeletes = draftStream.deleteCurrentMessage.mock.calls.length;
        await params.replyOptions?.onPlanUpdate?.({
          phase: "update",
          steps: [{ step: "Resume", status: "in_progress" }],
        });
        params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onItemEvent?.({
          itemId: "card-rejected",
          kind: "tool",
          name: "progress_card",
          phase: "end",
          status: "blocked",
        });
        params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onItemEvent?.(
          projectAgentToolActivity({ toolCallId: "exec-boundary", name: "exec", phase: "start" }),
        );
        await params.replyOptions?.onToolStart?.({
          toolCallId: "exec-boundary",
          name: "exec",
          phase: "start",
        });
        resumedProgress = draftStream.update.mock.calls.at(-1)?.[0];
        params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
        retractedProgress = draftStream.update.mock.calls.at(-1)?.[0];
        secondPlanRetractionDeletes = draftStream.deleteCurrentMessage.mock.calls.length;
        await params.replyOptions?.onItemEvent?.(
          projectAgentToolActivity({ toolCallId: "read-1", name: "read", phase: "start" }),
        );
        await params.replyOptions?.onToolStart?.({
          toolCallId: "read-1",
          name: "read",
          phase: "start",
        });
        params.replyOptions?.onAssistantMessageStart?.();
        params.replyOptions?.onReasoningEnd?.();
        await params.replyOptions?.onItemEvent?.(
          projectAgentToolActivity({ toolCallId: "exec-1", name: "exec", phase: "start" }),
        );
        await params.replyOptions?.onToolStart?.({
          toolCallId: "exec-1",
          name: "exec",
          phase: "start",
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool:read-1",
          kind: "tool",
          name: "read",
          status: "completed",
          progressText: "done",
        });
        await params.replyOptions?.onReasoningStream?.({ text: "Thinking" });
        await params.replyOptions?.onReasoningEnd?.();
        await params.replyOptions?.onReasoningStream?.({ text: "Checking" });
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool:read-1",
          kind: "tool",
          name: "read",
          status: "completed",
          progressText: "done",
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool:failed-1",
          kind: "tool",
          name: "exec",
          status: "failed",
        });
        await params.replyOptions?.onPlanUpdate?.({
          phase: "update",
          explanation: "1/2 complete",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        });
        await params.replyOptions?.onPlanUpdate?.({
          phase: "update",
          explanation: "Progress updated",
          steps: [],
        });
        await params.replyOptions?.onPlanUpdate?.({ phase: "update", steps: [] });
        await params.replyOptions?.onObservedReplyDelivery?.();
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool:late",
          kind: "tool",
          name: "exec",
          status: "running",
          progressText: "late progress",
        });
        expect(previewPostId).toBeUndefined();
        expect(visiblePreviewText).toBeUndefined();
        mockState.abortController?.abort();
      });

      await receivePost({ id: "post-progress", message: "run this" }, progressConfig);

      const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
      expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      expect(firstPlanRetractionDeletes).toBe(1);
      expect(resumedProgress).toContain("▸ Resume");
      if (toolProgress) {
        expect(resumedProgress).toContain("blocked");
        expect(resumedProgress).toContain("Exec");
        expect(retractedProgress).not.toContain("Resume");
        expect(retractedProgress).toContain("blocked");
        expect(secondPlanRetractionDeletes).toBe(1);
      } else {
        expect(resumedProgress).not.toContain("blocked");
        expect(resumedProgress).not.toContain("Exec");
        expect(secondPlanRetractionDeletes).toBe(2);
      }
      const updates = draftStream.update.mock.calls.map((call) => call[0]);
      if (toolProgress) {
        expect(updates.at(-1)).toContain("Read");
        expect(updates.at(-1)).toContain("done");
        expect(updates.at(-1)).toContain("failed");
      } else {
        expect(updates[0]).toBe("▸ Inspect");
        expect(updates.at(-1)).not.toContain("Read");
        expect(updates.at(-1)).not.toContain("done");
        expect(updates.join("\n")).not.toContain("failed");
      }
      if (mode === "progress") {
        expect(updates.at(-1)).toContain("Checking");
      }
      expect(updates.at(-1)).not.toContain("ThinkingChecking");
      expect(updates.some((text) => text.includes("1/2 complete"))).toBe(true);
      expect(updates.some((text) => text.includes("✅ Inspect"))).toBe(true);
      expect(updates.some((text) => text.includes("▸ Patch"))).toBe(true);
      expect(updates.some((text) => text.includes("Progress updated"))).toBe(true);
      expect(updates.join("\n")).not.toContain("<progress");
    },
  );

  it("finalizes only the current block when the terminal reply is cumulative", async () => {
    const blockConfig = withStreaming({ mode: "block" }, "[bot]");
    const runtimeCore = createRuntimeCore(blockConfig);
    mockState.runtimeCore = runtimeCore;
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

    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "First block" });
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Second block" });
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver(
        { text: "[bot] First block\n\nSecond block" },
        { kind: "final" },
      );
      mockState.abortController?.abort();
    });

    await receivePost(
      {
        id: "post-cumulative-final",
        message: "stream two blocks",
      },
      blockConfig,
    );

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

  it.each([false, true])(
    "records confirmed-preview participation when cleanup fails: %s",
    async (cleanupFails) => {
      const blockConfig = withStreaming({ mode: "block" });
      mockState.runtimeCore = createRuntimeCore(blockConfig);
      mockState.createMattermostDraftStream.mockReturnValue(
        createFinalDraft({
          discardPending: vi.fn(async () => {
            if (cleanupFails) {
              throw new Error("preview cleanup failed");
            }
          }),
          resolveFinalText: vi.fn(() => ({
            kind: "already-delivered" as const,
            publishedParts: [{ messageId: "preview-sealed", content: "Only block" }],
          })),
        }),
      );
      mockState.dispatchInboundMessage.mockImplementation(async (params) => {
        try {
          await params.replyOptions?.onAssistantMessageStart?.();
          await params.replyOptions?.onPartialReply?.({ text: "Only block" });
          await params.replyOptions?.onAssistantMessageStart?.();
          const dispatcherOptions =
            mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
          const delivered = dispatcherOptions?.deliver({ text: "Only block" }, { kind: "final" });
          if (cleanupFails) {
            await expect(delivered).rejects.toThrow("preview cleanup failed");
          } else {
            await delivered;
          }
        } finally {
          mockState.abortController?.abort();
        }
      });
      await receivePost(
        {
          id: "post-confirmed-preview",
          message: "stream one block",
          rootId: "thread-root-confirmed-preview",
        },
        blockConfig,
      );
      expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
      expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
        "default",
        "chan-1",
        "thread-root-confirmed-preview",
        { agentId: "main" },
      );
    },
  );

  it("records participation when a later send step fails after a visible thread post", async () => {
    const progressConfig = withStreaming({ mode: "progress", progress: { toolProgress: true } });
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "partial-post-1", channelId: "chan-1" }],
      kind: "text",
      replyToId: "thread-root-partial",
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
          const dispatcherOptions =
            mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
          await expect(
            dispatcherOptions?.deliver({ text: "Visible partial reply" }, { kind: "final" }),
          ).rejects.toThrow("bookkeeping failed");
          await dispatchParams.replyOptions?.onReasoningStream?.({ text: "late reasoning" });
        } finally {
          mockState.abortController?.abort();
        }
      },
    );

    await receivePost(
      {
        id: "post-partial-thread",
        message: "reply in this thread",
        rootId: "thread-root-partial",
      },
      progressConfig,
    );

    expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
      "default",
      "chan-1",
      "thread-root-partial",
      { agentId: "main" },
    );
    expect(mockState.progressDrafts.at(-1)?.getSnapshot().lines).toEqual([]);
  });
}
