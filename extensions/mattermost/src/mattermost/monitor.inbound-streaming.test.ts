// Mattermost tests cover inbound streaming and preview behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "./monitor.inbound-system-event.test-helper.js";
import {
  createRuntimeCore,
  emitMattermostChannelPost,
  getMattermostInboundTestState,
  resetMattermostInboundTestState,
  testRuntime,
} from "./monitor.inbound-system-event.test-support.js";
// Load the shared mocks before importing the monitor under test.
import { monitorMattermostProvider } from "./monitor.js";
import type { OpenClawConfig } from "./runtime-api.js";

const mockState = getMattermostInboundTestState();

describe("mattermost inbound streaming", () => {
  beforeEach(resetMattermostInboundTestState);

  it("merges Mattermost progress preview updates and clears after message-tool delivery", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const draftStream = {
      update: vi.fn(),
      flush: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
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
            mode: "progress",
            progress: {
              label: false,
              toolProgress: true,
            },
          },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onToolStart?.({
        toolCallId: "read-1",
        name: "read",
        phase: "start",
      });
      params.replyOptions?.onAssistantMessageStart?.();
      params.replyOptions?.onReasoningEnd?.();
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
      await params.replyOptions?.onObservedReplyDelivery?.();
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

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
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
    expect(updates.at(-1)).toContain("Read");
    expect(updates.at(-1)).toContain("Exec");
    expect(updates.at(-1)).toContain("done");
    expect(updates.at(-1)).toContain("Checking");
    expect(updates.at(-1)).not.toContain("ThinkingChecking");
  });

  it("keeps core block streaming enabled when preview streaming is off", async () => {
    const offConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: "off",
          blockStreaming: true,
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(offConfig);
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: offConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-streaming-off",
      message: "stream this in blocks",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(false);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBeUndefined();
  });

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
          streaming: { mode: "block", preview: { toolProgress: true } },
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
      resolveFinalText: (text: string) => ({ kind: "full" as const, text }),
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
      const firstToolStart = params.replyOptions?.onToolStart?.({
        toolCallId: "bash-1",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "ls" },
      });
      const secondToolStart = params.replyOptions?.onToolStart?.({
        toolCallId: "bash-2",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "pwd" },
      });
      const firstToolUpdate = params.replyOptions?.onToolStart?.({
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
      const consecutiveToolStart = params.replyOptions?.onToolStart?.({
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

    const monitor = monitorMattermostProvider({
      config: blockConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

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

  it("finalizes only the current block when the terminal reply is cumulative", async () => {
    const blockConfig: OpenClawConfig = {
      messages: { responsePrefix: "[bot]" },
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
    mockState.updateMattermostPost.mockRejectedValueOnce(new Error("edit failed"));
    const forceNewMessage = vi.fn(async () => {});
    const updateAssistantText = vi.fn();
    const resolveFinalText = vi.fn((text: string) =>
      text === "[bot] First block\n\nSecond block"
        ? { kind: "remaining" as const, text: "Second block" }
        : { kind: "full" as const, text },
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

    const monitor = monitorMattermostProvider({
      config: blockConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

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
      resolveFinalText: vi.fn(() => ({ kind: "already-delivered" as const })),
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

    const monitor = monitorMattermostProvider({
      config: blockConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

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
});
