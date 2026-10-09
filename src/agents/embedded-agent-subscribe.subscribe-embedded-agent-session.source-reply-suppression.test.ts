// Source-reply suppression after message-tool delivery.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
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
  options: {
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    hasDeliveredMessageToolOnlySourceReply?: () => boolean;
    onDeliveredMessageToolOnlySourceReply?: () => void;
    reasoningMode?: "off" | "on" | "stream";
    onReasoningEnd?: () => void;
    onReasoningStream?: (payload: { text?: string }) => void;
  } = {},
) {
  // Harness exposes both emitted block replies and subscription state so tests
  // can distinguish suppression from missing delivery tracking.
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
        {
          messageDelivery: details.messageDelivery,
        },
        true,
      );
    }
    rawEmit(evt);
  };
  const onBlockReply = vi.fn();
  const onPartialReply = vi.fn();
  const onAgentEvent = vi.fn();
  const subscription = subscribeEmbeddedAgentSession({
    session,
    runId: "run",
    onBlockReply,
    onPartialReply,
    onAgentEvent,
    onReasoningEnd: options.onReasoningEnd,
    onReasoningStream: options.onReasoningStream,
    blockReplyBreak,
    reasoningMode: options.reasoningMode,
    sourceReplyDeliveryMode: options.sourceReplyDeliveryMode,
    hasDeliveredMessageToolOnlySourceReply: options.hasDeliveredMessageToolOnlySourceReply,
    onDeliveredMessageToolOnlySourceReply: options.onDeliveredMessageToolOnlySourceReply,
  });
  return { emit, onAgentEvent, onBlockReply, onPartialReply, subscription };
}

async function emitMessageToolLifecycle(params: {
  emit: (evt: unknown) => void;
  toolCallId: string;
  message: string;
  media?: string;
  to?: string | null;
  action?: string;
  channelId?: string;
  threadId?: string;
  result: unknown;
}) {
  // Tool start preserves invocation context; completion records confirmed delivery.
  params.emit({
    type: "tool_execution_start",
    toolName: "message",
    toolCallId: params.toolCallId,
    args: {
      action: params.action ?? "send",
      ...(params.to === null ? {} : { to: params.to ?? "+1555" }),
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
      message: params.message,
      media: params.media,
    },
  });
  // Wait for async handler to complete.
  await Promise.resolve();
  params.emit({
    type: "tool_execution_end",
    toolName: "message",
    toolCallId: params.toolCallId,
    isError: false,
    result: attachCoreMessageDeliveryFact(params.result),
  });
}

function attachCoreMessageDeliveryFact(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  const details =
    record.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : undefined;
  const deliveryStatus = details?.deliveryStatus;
  const status =
    deliveryStatus === "sent"
      ? "settled"
      : deliveryStatus === "dry_run"
        ? "dryRun"
        : deliveryStatus === "suppressed"
          ? "suppressed"
          : undefined;
  return status && details
    ? {
        ...record,
        details: {
          ...details,
          messageDelivery: { status, partialDelivery: false, createdThreadIds: [] },
        },
      }
    : result;
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
  it("suppresses message_end block replies when the message tool already sent", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "This is the answer.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-1",
      message: messageText,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantMessageEnd(emit, messageText);
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("preserves a distinct automatic final after confirmed current-source thread delivery", async () => {
    const { emit, onBlockReply, subscription } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "automatic",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-current-thread",
      action: "thread-reply",
      channelId: "qa-room",
      threadId: "thread-1",
      message: "QA-THREAD-RECEIPT-TOOL-OK",
      to: null,
      result: {
        details: {
          ok: true,
          deliveryStatus: "sent",
          sourceReplyRoute: "current-source",
        },
      },
    });
    emitAssistantMessageEnd(emit, "QA-THREAD-RECEIPT-FINAL-OK");
    await subscription.waitForPendingEvents();

    expect(subscription.getSourceReplyDeliveryState()).toBe("delivered");
    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([
      "QA-THREAD-RECEIPT-FINAL-OK",
    ]);
  });

  it("suppresses later text_end block replies after message-tool-only delivery", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("text_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-text-end-continue",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantTextEndBlock(emit, "Done.");
    await Promise.resolve();
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("does not suppress source replies after non-message messaging tools send", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    emit({
      type: "tool_execution_start",
      toolName: "sessions_send",
      toolCallId: "tool-sessions-send",
      args: { message: "Sent to a spawned session." },
    });
    await Promise.resolve();
    emit({
      type: "tool_execution_end",
      toolName: "sessions_send",
      toolCallId: "tool-sessions-send",
      isError: false,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantMessageEnd(emit, "Reply to the current source.");
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });

  it("preserves internal source-reply payloads across compaction retries", async () => {
    const { emit, subscription } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-internal-before-compaction",
      message: "Visible terminal answer.",
      result: {
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
          sourceReply: { text: "Visible terminal answer." },
        },
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

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-after-reasoning",
      message: "Starting the requested work.",
      to: null,
      result: { details: { deliveryStatus: "sent" } },
    });
    emitAssistantMessageEnd(emit, "Private final output.");
    await Promise.resolve();

    expect(onReasoningEnd).not.toHaveBeenCalled();
  });

  it("uses runner-level delivery evidence when tool result details were rewritten", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end", {
      sourceReplyDeliveryMode: "message_tool_only",
      hasDeliveredMessageToolOnlySourceReply: () => true,
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-rewritten-result",
      message: "Starting the requested work.",
      to: null,
      result: { details: { rewritten: true } },
    });
    emitAssistantMessageEnd(emit, "Done after rewritten tool result.");
    await Promise.resolve();

    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("tracks media-only message tool sends as messaging delivery", async () => {
    const { emit, subscription } = createBlockReplyHarness("message_end");
    try {
      await emitMessageToolLifecycle({
        emit,
        toolCallId: "tool-message-media",
        message: "",
        media: "file:///tmp/render.mp4",
        result: { details: { deliveryStatus: "sent" } },
      });
      await subscription.waitForPendingEvents();

      expect(subscription.didSendViaMessagingTool()).toBe(true);
      expect(subscription.getMessagingToolSentMediaUrls()).toEqual(["file:///tmp/render.mp4"]);

      const expectedUrls = Array.from({ length: 200 }, (_, index) => `file:///img-${index}.jpg`);
      await emitMessageToolLifecycle({
        emit,
        toolCallId: "tool-message-media-cap",
        message: "",
        result: { details: { deliveryStatus: "sent", mediaUrls: [...expectedUrls] } },
      });
      await subscription.waitForPendingEvents();

      expect(subscription.getMessagingToolSentMediaUrls()).toEqual(expectedUrls);
      expect(subscription.getMessagingToolSentMediaUrls()).not.toContain("file:///tmp/render.mp4");
    } finally {
      subscription.unsubscribe();
    }
  });

  it("does not let an earlier approval prompt suppress the next user reply", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "approval-input-boundary",
      blockReplyBreak: "message_end",
      onBlockReply,
      onToolResult: async () => {},
    });
    emit({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "approval-request",
      isError: false,
      result: {
        details: {
          status: "approval-pending",
          approvalId: "approval-request",
          approvalSlug: "approval-request",
          host: "gateway",
          command: "echo approved",
        },
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
    subscription.unsubscribe();
  });

  it.each([
    { action: "reply", final: true },

    { action: "poll", final: true },
    { action: "send", final: false },
  ])(
    "keeps source progress distinct from final receipts for $action (final=$final)",
    async ({ action, final }) => {
      const { session, emit } = createStubSessionHarness();
      const sessionManager = session.sessionManager;
      const onBlockReply = vi.fn();
      const onDeliveredMessageToolOnlySourceReply = vi.fn();
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "implicit-source",
        sourceReplyDeliveryMode: "message_tool_only",
        blockReplyBreak: "message_end",
        onBlockReply,
        onDeliveredMessageToolOnlySourceReply,
      });
      emit({
        type: "tool_execution_start",
        toolName: "message",
        toolCallId: "source-send",
        args: { action, final, target: "channel:source", message: "Delivered once." },
      });
      await Promise.resolve();
      recordEmbeddedToolReceipt(
        sessionManager,
        "source-send",
        {
          messageDelivery: {
            status: "settled",
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
        },
        true,
      );
      emit({
        type: "tool_execution_end",
        toolName: "message",
        toolCallId: "source-send",
        isError: false,
        result: { content: [], details: { redacted: true } },
      });
      await Promise.resolve();

      expect(subscription.getSourceReplyDelivered()).toBe(true);
      expect(subscription.getSourceReplyDeliveryState()).toBe(final ? "delivered" : "missing");
      emitAssistantMessageEnd(emit, "A later assistant response must stay suppressed.");
      await Promise.resolve();
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(onDeliveredMessageToolOnlySourceReply).toHaveBeenCalledOnce();

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
      subscription.unsubscribe();
    },
  );

  it.each([
    { name: "a progress reaction", batch: ["reaction"], endsWithProgress: false },
    { name: "a partial progress send", batch: ["partial"], endsWithProgress: false },
  ])(
    "reports whether the last tool batch was source progress after $name",
    async ({ batch, endsWithProgress }) => {
      const { session, emit } = createStubSessionHarness();
      const sessionManager = session.sessionManager;
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "trailing-progress",
        sourceReplyDeliveryMode: "message_tool_only",
      });
      const runToolBatch = async (tools: string[]) => {
        emitAssistantMessageEnd(emit, "", {
          stopReason: "toolUse",
          content: tools.map((tool) => ({ type: "toolCall", id: tool, name: tool, arguments: {} })),
        });
        for (const tool of tools) {
          const partial = tool === "partial";
          const messageTool = tool === "progress" || tool === "reaction" || partial;
          const toolName = messageTool ? "message" : tool;
          emit({
            type: "tool_execution_start",
            toolName,
            toolCallId: tool,
            args:
              tool === "progress" || partial
                ? { action: "send", final: false, target: "channel:source", message: "Working." }
                : tool === "reaction"
                  ? { action: "react", final: false, target: "channel:source", emoji: "👀" }
                  : { path: "notes.txt" },
          });
          await Promise.resolve();
          if (messageTool) {
            recordEmbeddedToolReceipt(
              sessionManager,
              tool,
              {
                messageDelivery: {
                  status: "settled",
                  partialDelivery: partial,
                  createdThreadIds: [],
                  sourceReplyDelivered: true,
                },
              },
              true,
            );
          }
          emit({
            type: "tool_execution_end",
            toolName,
            toolCallId: tool,
            isError: partial,
            result: { content: [{ type: "text", text: "ok" }], details: {} },
          });
          await Promise.resolve();
        }
      };

      await runToolBatch(batch);
      emitAssistantMessageEnd(emit, "", { stopReason: "stop" });
      await subscription.waitForPendingEvents();

      expect(subscription.endsWithSourceProgress()).toBe(endsWithProgress);
      expect(subscription.getSourceReplyDeliveryState()).toBe("missing");
      subscription.unsubscribe();
    },
  );

  it("suppresses text-only tool summaries after message-tool-only delivery", async () => {
    const onToolResult = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-message-tool-progress",
      verboseLevel: "on",
      sourceReplyDeliveryMode: "message_tool_only",
      onToolResult,
    });

    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-final",
      message: "Final answer sent through the message tool.",
      result: { details: { status: "sent" } },
    });
    onToolResult.mockClear();

    emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-exec-late",
      args: { command: "false" },
    });
    await Promise.resolve();

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does not suppress message_end replies when message tool reports error", async () => {
    const { emit, onBlockReply } = createBlockReplyHarness("message_end");

    const messageText = "Please retry the send.";
    await emitMessageToolLifecycle({
      emit,
      toolCallId: "tool-message-err",
      message: messageText,
      result: { details: { status: "error" } },
    });
    emitAssistantMessageEnd(emit, messageText);
    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledTimes(1);
    });
  });
});
