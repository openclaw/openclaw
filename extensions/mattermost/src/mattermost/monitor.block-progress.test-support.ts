import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi, type Mock } from "vitest";
import { createFinalDraft } from "./monitor.preview-delivery.test-support.js";
import type { OpenClawConfig } from "./runtime-api.js";

export function registerMattermostBlockProgressTests(harness: {
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
  testConfig: OpenClawConfig;
  receivePost: (post: { id: string; message: string }, config: OpenClawConfig) => Promise<unknown>;
  mockState: {
    runtimeCore: unknown;
    abortController: AbortController | undefined;
    createMattermostDraftStream: Mock;
    dispatchInboundMessage: Mock;
    createReplyDispatcherWithTyping: Mock;
    sendMessageMattermost: Mock;
  };
}) {
  const { testConfig, createRuntimeCore, receivePost, mockState } = harness;
  it("preserves text-tool-text boundaries while grouping interleaved tool updates", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          ...testConfig.channels?.mattermost,
          streaming: {
            mode: "block",
            preview: { toolProgress: true, commandText: "raw" },
          },
        },
      },
    };
    const chunkMarkdownTextWithMode = vi.fn((text: string) => [text]);
    mockState.runtimeCore = createRuntimeCore(blockConfig, undefined, {
      chunkMarkdownTextWithMode,
      chunkMode: "newline",
      textChunkLimit: 1234,
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

    const boundaries: Record<string, number> = {};
    let interleavedToolDraft = "";
    let reasoningDraft = "";
    let finalToolDraft = "";
    let secondPartialArrivedBeforeBoundarySettled = false;
    let finalDeliveryWaitedForBoundary = false;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      const toolEvent = (
        toolCallId: string,
        command: string,
        phase: "start" | "update" = "start",
      ) => {
        const event = { toolCallId, name: "bash", phase, args: { command } };
        const pending = params.replyOptions?.onItemEvent?.(projectAgentToolActivity(event));
        void params.replyOptions?.onToolStart?.({ ...event, detailMode: "raw" });
        return pending;
      };
      await params.replyOptions?.onAssistantMessageStart?.();
      params.replyOptions?.onPartialReply?.({ text: "A much longer first block" });
      const firstToolStart = toolEvent("bash-1", "ls");
      const secondToolStart = toolEvent("bash-2", "pwd");
      const firstToolUpdate = toolEvent("bash-1", "ls -alh", "update");
      boundaries.sameToolUpdate = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningEnd?.();
      boundaries.hiddenReasoning = forceNewMessage.mock.calls.length;
      const consecutiveToolStart = toolEvent("bash-3", "whoami");
      boundaries.consecutiveTool = forceNewMessage.mock.calls.length;
      interleavedToolDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");

      params.replyOptions?.onAssistantMessageStart?.();
      const assistantBoundary = params.replyOptions?.onPartialReply?.({ text: "Done." });
      secondPartialArrivedBeforeBoundarySettled =
        !assistantBoundarySettled && draftUpdate.mock.calls.at(-1)?.[0] === "Done.";
      toolBoundary.resolve();
      assistantBoundaryGate.resolve();
      await Promise.all([
        firstToolStart,
        secondToolStart,
        firstToolUpdate,
        consecutiveToolStart,
        assistantBoundary,
      ]);
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Private chain of thought" });
      boundaries.reasoningStart = forceNewMessage.mock.calls.length;
      reasoningDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");
      await params.replyOptions?.onReasoningEnd?.();
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Second reasoning item" });
      boundaries.secondReasoning = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Answer after reasoning" });
      boundaries.reasoningText = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      const finalEvent = {
        toolCallId: "bash-final",
        name: "bash",
        phase: "start" as const,
        args: { command: "date" },
      };
      // This boundary is sequential, unlike the interleaved starts above.
      await params.replyOptions?.onItemEvent?.(projectAgentToolActivity(finalEvent));
      await params.replyOptions?.onToolStart?.({ ...finalEvent, detailMode: "raw" });
      boundaries.toolBeforeFinal = forceNewMessage.mock.calls.length;
      finalToolDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      const finalDelivery = dispatcherOptions?.deliver(
        { text: "Final without a partial" },
        { kind: "final" },
      );
      boundaries.finalOnly = forceNewMessage.mock.calls.length;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      finalDeliveryWaitedForBoundary = mockState.sendMessageMattermost.mock.calls.length === 0;
      finalBoundary.resolve();
      await finalDelivery;
      mockState.abortController?.abort();
    });

    await receivePost({ id: "post-tool-progress", message: "run a tool" }, blockConfig);

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const draftStreamOptions = mockState.createMattermostDraftStream.mock.calls.at(0)?.[0] as
      | { chunkText?: (text: string) => string[] }
      | undefined;
    chunkMarkdownTextWithMode.mockClear();
    expect(draftStreamOptions?.chunkText?.("first\n\nsecond")).toEqual(["first\n\nsecond"]);
    expect(chunkMarkdownTextWithMode).toHaveBeenCalledWith("first\n\nsecond", 1234, "newline");
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions).toMatchObject({
      disableBlockStreaming: true,
      preserveProgressCallbackStartOrder: true,
    });
    expect(boundaries).toEqual({
      sameToolUpdate: 1,
      hiddenReasoning: 1,
      consecutiveTool: 1,
      reasoningStart: 3,
      secondReasoning: 3,
      reasoningText: 3,
      toolBeforeFinal: 4,
      finalOnly: 5,
    });
    expect(interleavedToolDraft).toContain("pwd");
    expect(interleavedToolDraft).toContain("ls -alh");
    expect(interleavedToolDraft).toContain("whoami");
    expect(reasoningDraft).toBe("Thinking…");
    expect(finalToolDraft).toContain("date");
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
