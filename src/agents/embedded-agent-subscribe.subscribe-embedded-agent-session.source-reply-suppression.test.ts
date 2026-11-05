import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordEmbeddedToolReceipt } from "./embedded-agent-runner/tool-send-receipts.js";
import {
  createSubscribedSessionHarness,
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

const retryingCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "overflow",
    outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: true },
  }) as const;

function createBlockReplyHarness(
  blockReplyBreak: "message_end" | "text_end",
  options: Pick<
    Parameters<typeof subscribeEmbeddedAgentSession>[0],
    | "sourceReplyDeliveryMode"
    | "hasDeliveredMessageToolOnlySourceReply"
    | "onDeliveredMessageToolOnlySourceReply"
    | "reasoningMode"
    | "onReasoningEnd"
    | "onReasoningStream"
    | "onToolResult"
    | "verboseLevel"
  > = {},
  withBlockReply = true,
) {
  const { session, emit: rawEmit } = createStubSessionHarness();
  const sessionManager = session.sessionManager;
  const emit = (evt: unknown) => {
    const event = asOptionalRecord(evt);
    const details = asOptionalRecord(asOptionalRecord(event?.result)?.details);
    if (
      event?.type === "tool_execution_end" &&
      event.toolName === "message" &&
      typeof event.toolCallId === "string" &&
      details?.messageDelivery !== undefined
    ) {
      recordEmbeddedToolReceipt(
        sessionManager,
        event.toolCallId,
        { messageDelivery: details.messageDelivery },
        true,
      );
    }
    rawEmit(evt);
  };
  const onBlockReply = vi.fn();
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId: "run",
    ...(withBlockReply ? { onBlockReply } : {}),
    blockReplyBreak,
    ...options,
  });
  onTestFinished(() => subscription.unsubscribe());
  return {
    emit,
    onBlockReply,
    subscription,
    receipt: (id: string, partialDelivery = false) =>
      recordEmbeddedToolReceipt(
        sessionManager,
        id,
        {
          messageDelivery: {
            status: "settled",
            partialDelivery,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
        },
        true,
      ),
  };
}

function startTool(emit: (event: unknown) => void, name: string, id: string, args: unknown) {
  emit({ type: "tool_execution_start", toolName: name, toolCallId: id, args });
}
function endTool(
  emit: (event: unknown) => void,
  name: string,
  id: string,
  result: unknown,
  isError = false,
) {
  emit({ type: "tool_execution_end", toolName: name, toolCallId: id, isError, result });
}

async function emitMessageToolLifecycle(
  emit: (evt: unknown) => void,
  message: string,
  params: {
    toolCallId?: string;
    media?: string;
    to?: string | null;
    action?: string;
    channelId?: string;
    threadId?: string;
    details?: Record<string, unknown>;
  } = {},
) {
  const id = params.toolCallId ?? "tool-message-1";
  startTool(emit, "message", id, {
    action: params.action ?? "send",
    ...(params.to === null ? {} : { to: params.to ?? "+1555" }),
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    message,
    media: params.media,
  });
  await Promise.resolve();
  const details = params.details ?? { deliveryStatus: "sent" };
  endTool(emit, "message", id, {
    details: {
      ...details,
      ...(details.deliveryStatus === "sent"
        ? {
            messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
          }
        : {}),
    },
  });
}

function emitAssistantMessageEnd(
  emit: (evt: unknown) => void,
  text: string,
  overrides?: Partial<AssistantMessage>,
) {
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    ...overrides,
  } as AssistantMessage;
  emit({ type: "message_end", message: assistantMessage });
}

function emitAssistantTextEndBlock(emit: (evt: unknown) => void, text: string) {
  emit({ type: "message_start", message: { role: "assistant" } });
  emitAssistantTextDelta({ emit, delta: text });
  emitAssistantTextEnd({ emit });
}

describe("subscribeEmbeddedAgentSession", () => {
  it.each(["matching final", "later text_end", "rewritten result"] as const)(
    "suppresses %s after message-tool delivery",
    async (scenario) => {
      const textEnd = scenario === "later text_end";
      const rewritten = scenario === "rewritten result";
      const { emit, onBlockReply } = createBlockReplyHarness(textEnd ? "text_end" : "message_end", {
        sourceReplyDeliveryMode: scenario === "matching final" ? undefined : "message_tool_only",
        ...(rewritten ? { hasDeliveredMessageToolOnlySourceReply: () => true } : {}),
      });
      await emitMessageToolLifecycle(emit, "This is the answer.", {
        ...(scenario !== "matching final" ? { to: null } : {}),
        ...(rewritten ? { details: { rewritten: true } } : {}),
      });
      if (textEnd) {
        emitAssistantTextEndBlock(emit, "Done.");
      } else {
        emitAssistantMessageEnd(
          emit,
          rewritten ? "Done after rewritten tool result." : "This is the answer.",
        );
      }
      await Promise.resolve();
      if (textEnd) {
        await Promise.resolve();
      }
      expect(onBlockReply).not.toHaveBeenCalled();
    },
  );

  it("suppresses a distinct automatic final after confirmed current-source thread delivery", async () => {
    const { emit, onBlockReply, subscription } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "automatic",
    });

    await emitMessageToolLifecycle(emit, "QA-THREAD-RECEIPT-TOOL-OK", {
      action: "thread-reply",
      channelId: "qa-room",
      threadId: "thread-1",
      to: null,
      details: {
        ok: true,
        deliveryStatus: "sent",
        sourceReplyRoute: "current-source",
      },
    });
    emitAssistantMessageEnd(emit, "QA-THREAD-RECEIPT-FINAL-OK");
    await subscription.waitForPendingEvents();

    expect(subscription.getSourceReplyDeliveryState()).toBe("delivered");
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not suppress source replies after non-message messaging tools send", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    startTool(emit, "sessions_send", "tool-sessions-send", {
      message: "Sent to a spawned session.",
    });
    await Promise.resolve();
    endTool(emit, "sessions_send", "tool-sessions-send", { details: { deliveryStatus: "sent" } });
    emitAssistantMessageEnd(emit, "Reply to the current source.");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves internal source-reply payloads across compaction retries", async () => {
    const { emit, subscription } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle(emit, "Visible terminal answer.", {
      details: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReply: { text: "Visible terminal answer." },
      },
    });
    emit(retryingCompactionEnd());
    await Promise.resolve();

    expect(subscription.getMessagingToolSourceReplyPayloads()).toEqual([
      { text: "Visible terminal answer." },
    ]);
  });

  it("does not expose a reasoning boundary after message-tool-only delivery", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    const { emit } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
      reasoningMode: "stream",
      onReasoningEnd,
      onReasoningStream,
    });
    emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] },
      assistantMessageEvent: { type: "thinking_delta", delta: "private" },
    });
    expect(onReasoningStream).toHaveBeenCalledTimes(1);
    await emitMessageToolLifecycle(emit, "Starting the requested work.", { to: null });
    emitAssistantMessageEnd(emit, "Private final output.");
    await Promise.resolve();

    expect(onReasoningEnd).not.toHaveBeenCalled();
  });

  it("tracks media-only message tool sends as messaging delivery", async () => {
    const { emit, subscription } = createBlockReplyHarness("message_end");
    await emitMessageToolLifecycle(emit, "", {
      media: "file:///tmp/render.mp4",
    });
    await subscription.waitForPendingEvents();

    expect(subscription.didSendViaMessagingTool()).toBe(true);
    expect(subscription.getMessagingToolSentMediaUrls()).toEqual(["file:///tmp/render.mp4"]);
    const expectedUrls = Array.from({ length: 200 }, (_, index) => `file:///img-${index}.jpg`);
    await emitMessageToolLifecycle(emit, "", {
      toolCallId: "tool-message-media-cap",
      details: { deliveryStatus: "sent", mediaUrls: [...expectedUrls] },
    });
    await subscription.waitForPendingEvents();

    expect(subscription.getMessagingToolSentMediaUrls()).toEqual(expectedUrls);
    expect(subscription.getMessagingToolSentMediaUrls()).not.toContain("file:///tmp/render.mp4");
  });

  it("does not let an earlier approval prompt suppress the next user reply", async () => {
    const { emit, subscription, onBlockReply } = createBlockReplyHarness("message_end", {
      onToolResult: async () => {},
    });
    endTool(emit, "exec", "approval-request", {
      details: {
        status: "approval-pending",
        approvalId: "approval-request",
        approvalSlug: "approval-request",
        host: "gateway",
        command: "echo approved",
      },
    });
    await subscription.waitForPendingEvents();
    expect(subscription.didSendDeterministicApprovalPrompt()).toBe(true);
    emitAssistantMessageEnd(emit, "Waiting for approval.");
    await subscription.waitForPendingEvents();
    expect(onBlockReply).not.toHaveBeenCalled();
    emit({
      type: "message_end",
      message: { role: "user", content: "A new request.", timestamp: 2 },
    });
    emitAssistantMessageEnd(emit, "The new request has its own answer.");
    await subscription.waitForPendingEvents();
    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
      "The new request has its own answer.",
    ]);
    expect(subscription.didSendDeterministicApprovalPrompt()).toBe(false);
  });

  it.each([
    { action: "poll", final: true, mode: "message_tool_only" },
    { action: "send", final: false, mode: "automatic" },
    { action: "react", final: true, mode: "automatic" },
  ])(
    "keeps source progress distinct from final receipts for $action (final=$final, mode=$mode)",
    async ({ action, final, mode }) => {
      const onDeliveredMessageToolOnlySourceReply = vi.fn();
      const { emit, subscription, onBlockReply, receipt } = createBlockReplyHarness("message_end", {
        sourceReplyDeliveryMode: mode as "automatic" | "message_tool_only",
        onDeliveredMessageToolOnlySourceReply,
      });
      startTool(emit, "message", "source-send", {
        action,
        final,
        target: "channel:source",
        message: "Delivered once.",
      });
      await Promise.resolve();
      receipt("source-send");
      endTool(emit, "message", "source-send", { content: [], details: { redacted: true } });
      await Promise.resolve();

      expect(subscription.getSourceReplyDelivered()).toBe(true);
      expect(subscription.getSourceReplyDeliveryState()).toBe(final ? "delivered" : "missing");
      emitAssistantMessageEnd(emit, "A later assistant response.");
      await subscription.waitForPendingEvents();
      if (mode === "automatic" && !final) {
        expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
          "A later assistant response.",
        ]);
      } else {
        expect(onBlockReply).not.toHaveBeenCalled();
      }
      expect(onDeliveredMessageToolOnlySourceReply).toHaveBeenCalledOnce();
      onBlockReply.mockClear();

      emit({
        type: "message_end",
        message: { role: "user", content: "A new request.", timestamp: 2 },
      });
      emitAssistantMessageEnd(emit, "The new request still needs its own reply.");
      await subscription.waitForPendingEvents();
      expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
        "The new request still needs its own reply.",
      ]);
      expect(subscription.getSourceReplyDeliveryState()).toBe("missing");
    },
  );

  it("does not count a partial progress send as a completed source-progress batch", async () => {
    const { emit, subscription, receipt } = createBlockReplyHarness(
      "message_end",
      {
        sourceReplyDeliveryMode: "message_tool_only",
      },
      false,
    );
    emitAssistantMessageEnd(emit, "", {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "partial", name: "partial", arguments: {} }],
    });
    startTool(emit, "message", "partial", {
      action: "send",
      final: false,
      target: "channel:source",
      message: "Working.",
    });
    await Promise.resolve();
    receipt("partial", true);
    endTool(
      emit,
      "message",
      "partial",
      { content: [{ type: "text", text: "ok" }], details: {} },
      true,
    );
    await Promise.resolve();
    emitAssistantMessageEnd(emit, "", { stopReason: "stop" });
    await subscription.waitForPendingEvents();

    expect(subscription.endsWithSourceProgress()).toBe(false);
    expect(subscription.getSourceReplyDeliveryState()).toBe("missing");
  });

  it("suppresses text-only tool summaries after message-tool-only delivery", async () => {
    const onToolResult = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-message-tool-progress",
      verboseLevel: "on",
      sourceReplyDeliveryMode: "message_tool_only",
      onToolResult,
    });
    await emitMessageToolLifecycle(emit, "Final answer sent through the message tool.", {
      details: { status: "sent" },
    });
    onToolResult.mockClear();

    startTool(emit, "exec", "tool-exec-late", { command: "false" });
    await Promise.resolve();

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does not suppress message_end replies when message tool reports error", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "Please retry the send.";
    await emitMessageToolLifecycle(emit, messageText, {
      toolCallId: "tool-message-err",
      details: { status: "error" },
    });
    emitAssistantMessageEnd(emit, messageText);
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });
});
