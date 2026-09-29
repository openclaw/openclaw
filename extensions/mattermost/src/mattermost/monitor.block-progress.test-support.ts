import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";

type ProgressSocket = {
  openListenerCount: number;
  emitOpen: () => void;
  emitClose: (code: number) => void;
};

export function registerMattermostBlockProgressTests<Socket extends ProgressSocket>(harness: {
  FakeWebSocket: new () => Socket;
  createRuntimeCore: (
    config: OpenClawConfig,
    route: undefined,
    options: {
      chunkMarkdownTextWithMode: (
        text: string,
        limit: number,
        mode: "length" | "newline",
      ) => string[];
      chunkMode: "newline";
      textChunkLimit: number;
    },
  ) => unknown;
  startTestMonitor: (
    config: OpenClawConfig,
    abort: AbortController,
    socket: Socket,
  ) => Promise<void>;
  emitMattermostChannelPost: (
    socket: Socket,
    post: { id: string; message: string },
  ) => Promise<void>;
  mockState: {
    runtimeCore: unknown;
    abortController: AbortController | undefined;
    createMattermostDraftStream: Mock;
    dispatchInboundMessage: Mock;
    createReplyDispatcherWithTyping: Mock;
    sendMessageMattermost: Mock;
  };
}) {
  const {
    FakeWebSocket,
    createRuntimeCore,
    startTestMonitor,
    emitMattermostChannelPost,
    mockState,
  } = harness;
  it("preserves text-tool-text boundaries while grouping interleaved tool updates", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "block",
            preview: { toolProgress: true, commandText: "raw" },
          },
        },
      },
    };
    const chunkMarkdownTextWithMode = vi.fn((text: string) => [text]);
    const runtimeCore = createRuntimeCore(blockConfig, undefined, {
      chunkMarkdownTextWithMode,
      chunkMode: "newline",
      textChunkLimit: 1234,
    });
    mockState.runtimeCore = runtimeCore;
    const draftUpdate = vi.fn();
    const forceNewMessage = vi.fn(async () => {});
    let releaseToolBoundary: (() => void) | undefined;
    let releaseAssistantBoundary: (() => void) | undefined;
    let releaseFinalBoundary: (() => void) | undefined;
    let assistantBoundarySettled = false;
    const toolBoundaryPending = new Promise<void>((resolve) => {
      releaseToolBoundary = resolve;
    });
    const assistantBoundaryPending = new Promise<void>((resolve) => {
      releaseAssistantBoundary = resolve;
    });
    const finalBoundaryPending = new Promise<void>((resolve) => {
      releaseFinalBoundary = resolve;
    });
    forceNewMessage.mockImplementation(async () => {
      const callNumber = forceNewMessage.mock.calls.length;
      if (callNumber === 1) {
        await toolBoundaryPending;
        return;
      }
      if (callNumber === 2) {
        await assistantBoundaryPending;
        assistantBoundarySettled = true;
        return;
      }
      if (callNumber === 5) {
        await finalBoundaryPending;
      }
    });
    mockState.createMattermostDraftStream.mockReturnValue({
      update: draftUpdate,
      updateAssistantText: draftUpdate,
      forceNewMessage,
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
    let sameToolUpdateBoundaryCount = -1;
    let hiddenReasoningBoundaryCount = -1;
    let consecutiveToolBoundaryCount = -1;
    let reasoningStartBoundaryCount = -1;
    let secondReasoningBoundaryCount = -1;
    let reasoningTextBoundaryCount = -1;
    let toolBeforeFinalBoundaryCount = -1;
    let finalOnlyBoundaryCount = -1;
    let interleavedToolDraft = "";
    let reasoningDraft = "";
    let finalToolDraft = "";
    let secondPartialArrivedBeforeBoundarySettled = false;
    let finalDeliveryWaitedForBoundary = false;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      params.replyOptions?.onPartialReply?.({ text: "A much longer first block" });
      const firstToolStart = params.replyOptions?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "bash-1",
          name: "bash",
          phase: "start",
          args: { command: "ls" },
        }),
      );
      void params.replyOptions?.onToolStart?.({
        toolCallId: "bash-1",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "ls" },
      });
      const secondToolStart = params.replyOptions?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "bash-2",
          name: "bash",
          phase: "start",
          args: { command: "pwd" },
        }),
      );
      void params.replyOptions?.onToolStart?.({
        toolCallId: "bash-2",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "pwd" },
      });
      const firstToolUpdate = params.replyOptions?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "bash-1",
          name: "bash",
          phase: "update",
          args: { command: "ls -alh" },
        }),
      );
      void params.replyOptions?.onToolStart?.({
        toolCallId: "bash-1",
        name: "bash",
        phase: "update",
        detailMode: "raw",
        args: { command: "ls -alh" },
      });
      sameToolUpdateBoundaryCount = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningEnd?.();
      hiddenReasoningBoundaryCount = forceNewMessage.mock.calls.length;
      const consecutiveToolStart = params.replyOptions?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "bash-3",
          name: "bash",
          phase: "start",
          args: { command: "whoami" },
        }),
      );
      void params.replyOptions?.onToolStart?.({
        toolCallId: "bash-3",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "whoami" },
      });
      consecutiveToolBoundaryCount = forceNewMessage.mock.calls.length;
      interleavedToolDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");

      params.replyOptions?.onAssistantMessageStart?.();
      const assistantBoundary = params.replyOptions?.onPartialReply?.({ text: "Done." });
      secondPartialArrivedBeforeBoundarySettled =
        !assistantBoundarySettled && draftUpdate.mock.calls.at(-1)?.[0] === "Done.";
      releaseToolBoundary?.();
      releaseAssistantBoundary?.();
      await Promise.all([
        firstToolStart,
        secondToolStart,
        firstToolUpdate,
        consecutiveToolStart,
        assistantBoundary,
      ]);
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Private chain of thought" });
      reasoningStartBoundaryCount = forceNewMessage.mock.calls.length;
      reasoningDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");
      await params.replyOptions?.onReasoningEnd?.();
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Second reasoning item" });
      secondReasoningBoundaryCount = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Answer after reasoning" });
      reasoningTextBoundaryCount = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onItemEvent?.(
        projectAgentToolActivity({
          toolCallId: "bash-final",
          name: "bash",
          phase: "start",
          args: { command: "date" },
        }),
      );
      await params.replyOptions?.onToolStart?.({
        toolCallId: "bash-final",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "date" },
      });
      toolBeforeFinalBoundaryCount = forceNewMessage.mock.calls.length;
      finalToolDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      const finalDelivery = dispatcherOptions?.deliver(
        { text: "Final without a partial" },
        { kind: "final" },
      );
      finalOnlyBoundaryCount = forceNewMessage.mock.calls.length;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      finalDeliveryWaitedForBoundary = mockState.sendMessageMattermost.mock.calls.length === 0;
      releaseFinalBoundary?.();
      await finalDelivery;
      abortController.abort();
    });

    const monitor = startTestMonitor(blockConfig, abortController, socket);

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-tool-progress",
      message: "run a tool",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const draftStreamOptions = mockState.createMattermostDraftStream.mock.calls.at(0)?.[0] as
      | { chunkText?: (text: string) => string[] }
      | undefined;
    chunkMarkdownTextWithMode.mockClear();
    expect(draftStreamOptions?.chunkText?.("first\n\nsecond")).toEqual(["first\n\nsecond"]);
    expect(chunkMarkdownTextWithMode).toHaveBeenCalledWith("first\n\nsecond", 1234, "newline");
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(true);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBe(true);
    expect(sameToolUpdateBoundaryCount).toBe(1);
    expect(hiddenReasoningBoundaryCount).toBe(1);
    expect(consecutiveToolBoundaryCount).toBe(1);
    expect(reasoningStartBoundaryCount).toBe(3);
    expect(secondReasoningBoundaryCount).toBe(3);
    expect(reasoningTextBoundaryCount).toBe(3);
    expect(toolBeforeFinalBoundaryCount).toBe(4);
    expect(interleavedToolDraft).toContain("pwd");
    expect(interleavedToolDraft).toContain("ls -alh");
    expect(interleavedToolDraft).toContain("whoami");
    expect(reasoningDraft).toBe("Thinking…");
    expect(finalToolDraft).toContain("date");
    expect(finalOnlyBoundaryCount).toBe(5);
    expect(forceNewMessage).toHaveBeenCalledTimes(5);
    expect(finalDeliveryWaitedForBoundary).toBe(true);
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "Final without a partial",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(secondPartialArrivedBeforeBoundarySettled).toBe(true);
    expect(draftUpdate).toHaveBeenNthCalledWith(1, "A much longer first block");
    expect(draftUpdate).toHaveBeenCalledWith("Done.");
    expect(draftUpdate).toHaveBeenCalledWith("Answer after reasoning");
  });
}
