import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig, ReplyPayload } from "./runtime-api.js";

type PreviewSocket = {
  openListenerCount: number;
  emitOpen: () => void;
  emitClose: (code: number) => void;
  emitMessage: (payload: unknown) => Promise<void>;
};

export function registerMattermostPreviewDeliveryTests<Socket extends PreviewSocket>(harness: {
  FakeWebSocket: new () => Socket;
  createRuntimeCore: (config: OpenClawConfig) => unknown;
  startTestMonitor: (
    config: OpenClawConfig,
    abort: AbortController,
    socket: Socket,
  ) => Promise<void>;
  emitMattermostChannelPost: (
    socket: Socket,
    post: { id: string; message: string; rootId?: string },
  ) => Promise<void>;
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
  const {
    FakeWebSocket,
    createRuntimeCore,
    startTestMonitor,
    emitMattermostChannelPost,
    mockState,
  } = harness;
  it.each([
    { toolProgress: undefined, label: "Working", mode: "progress" },
    { toolProgress: false, label: "Working", mode: "progress" },
    { toolProgress: true, label: "Working", mode: "progress" },
    { toolProgress: false, label: false, mode: "progress" },
    { toolProgress: true, label: false, mode: "partial" },
    { toolProgress: true, label: false, mode: "block" },
  ] as const)(
    "keeps Mattermost $mode progress with $toolProgress and label $label",
    async ({ toolProgress, label, mode }) => {
      const socket = new FakeWebSocket();
      const abortController = new AbortController();
      mockState.abortController = abortController;
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
      const progressConfig: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            baseUrl: "https://mattermost.example.com",
            botToken: "bot-token",
            chatmode: "onmessage",
            dmPolicy: "open",
            groupPolicy: "open",
            streaming: {
              mode,
              progress: {
                label,
                toolProgress,
              },
            },
          },
        },
      };
      mockState.runtimeCore = createRuntimeCore(progressConfig);
      let firstPlanRetractionDeletes = 0;
      let resumedProgress: string | undefined;
      let retractedProgress: string | undefined;
      let secondPlanRetractionDeletes = 0;
      mockState.dispatchInboundMessage.mockImplementation(async (params) => {
        if (label === false) {
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
        }
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
        abortController.abort();
      });

      const monitor = startTestMonitor(progressConfig, abortController, socket);

      await vi.waitFor(() => {
        expect(socket.openListenerCount).toBeGreaterThan(0);
      });
      socket.emitOpen();

      await socket.emitMessage({
        event: "posted",
        data: {
          channel_id: "chan-1",
          channel_name: "town-square",
          channel_display_name: "Town Square",
          sender_name: "alice",
          post: JSON.stringify({
            id: "post-progress",
            channel_id: "chan-1",
            user_id: "user-1",
            message: "run this",
            create_at: 1_714_000_000_000,
          }),
        },
        broadcast: {
          channel_id: "chan-1",
          user_id: "user-1",
        },
      });
      socket.emitClose(1000);
      await monitor;

      const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
      expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      if (label === false) {
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
      }
      const updates = draftStream.update.mock.calls.map((call) => call[0]);
      if (toolProgress) {
        expect(updates.at(-1)).toContain("Read");
        expect(updates.at(-1)).toContain("done");
        expect(updates.at(-1)).toContain("failed");
      } else {
        expect(updates[0]).toBe(label === false ? "▸ Inspect" : "Working");
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
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "block" },
          responsePrefix: "[bot]",
        },
      },
    };
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
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText,
      forceNewMessage,
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => "preview-current"),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText,
    });

    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
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
      abortController.abort();
    });

    const monitor = startTestMonitor(blockConfig, abortController, socket);

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-cumulative-final",
      message: "stream two blocks",
    });
    socket.emitClose(1000);
    await monitor;

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

  it("records participation when the confirmed preview already contains the final", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "block" },
        },
      },
    };
    const runtimeCore = createRuntimeCore(blockConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.createMattermostDraftStream.mockReturnValue({
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
      resolveFinalText: vi.fn(() => ({
        kind: "already-delivered" as const,
        publishedParts: [{ messageId: "preview-sealed", content: "Only block" }],
      })),
    });

    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Only block" });
      await params.replyOptions?.onAssistantMessageStart?.();
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver({ text: "Only block" }, { kind: "final" });
      abortController.abort();
    });

    const monitor = startTestMonitor(blockConfig, abortController, socket);

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-confirmed-preview-final",
      message: "stream one block",
      rootId: "thread-root-confirmed-preview",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
      "default",
      "chan-1",
      "thread-root-confirmed-preview",
      { agentId: "main" },
    );
  });

  it("records participation when confirmed-preview cleanup fails", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "block" },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(blockConfig);
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {
        throw new Error("preview cleanup failed");
      }),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: vi.fn(() => ({
        kind: "already-delivered" as const,
        publishedParts: [{ messageId: "preview-sealed", content: "Only block" }],
      })),
    });

    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      try {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "Only block" });
        await params.replyOptions?.onAssistantMessageStart?.();
        const dispatcherOptions =
          mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
        await expect(
          dispatcherOptions?.deliver({ text: "Only block" }, { kind: "final" }),
        ).rejects.toThrow("preview cleanup failed");
      } finally {
        abortController.abort();
      }
    });

    const monitor = startTestMonitor(blockConfig, abortController, socket);

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-confirmed-preview-cleanup-failure",
      message: "stream one block",
      rootId: "thread-root-confirmed-preview-cleanup-failure",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
      "default",
      "chan-1",
      "thread-root-confirmed-preview-cleanup-failure",
      { agentId: "main" },
    );
  });

  it("records participation when a later send step fails after a visible thread post", async () => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "progress", progress: { toolProgress: true } },
        },
      },
    };
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
    mockState.createMattermostDraftStream.mockReturnValue({
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
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
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
          abortController.abort();
        }
      },
    );

    const monitor = startTestMonitor(progressConfig, abortController, socket);

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-partial-thread",
      message: "reply in this thread",
      rootId: "thread-root-partial",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
      "default",
      "chan-1",
      "thread-root-partial",
      { agentId: "main" },
    );
    expect(mockState.progressDrafts.at(-1)?.getSnapshot().lines).toEqual([]);
  });
}
