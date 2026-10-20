import { vi, type Mock } from "vitest";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import { handleMessageEnd } from "./embedded-agent-subscribe.handlers.messages.lifecycle.js";
import { handleMessageUpdate } from "./embedded-agent-subscribe.handlers.messages.update.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";
import { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import { createStreamRendering } from "./embedded-agent-subscribe.stream-rendering.js";

type ContextOptions = {
  onAgentEvent?: Mock;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  state?: Record<string, unknown>;
};
function baseContext(params: ContextOptions) {
  return {
    params: {
      runId: "run-1",
      session: { id: "session-1" },
      ...(params.sourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: params.sourceReplyDeliveryMode }
        : {}),
      ...(params.onAgentEvent ? { onAgentEvent: params.onAgentEvent } : {}),
    },
    noteLastAssistant: vi.fn(),
    captureModelEvent: vi.fn(),
    blockChunker: new EmbeddedBlockChunker(),
  };
}

export function updateMessage(
  context: EmbeddedAgentSubscribeContext,
  event: { message: unknown; assistantMessageEvent?: unknown },
) {
  // Stream fixtures intentionally include incomplete and malformed provider payloads.
  return handleMessageUpdate(context, {
    type: "message_update",
    ...event,
  } as Parameters<typeof handleMessageUpdate>[1]);
}

export function endMessage(context: EmbeddedAgentSubscribeContext, event: { message: unknown }) {
  // Message-end coverage includes malformed content and partial provider usage.
  return handleMessageEnd(context, {
    type: "message_end",
    ...event,
  } as Parameters<typeof handleMessageEnd>[1]);
}

export function createMessageUpdateContext(
  params: ContextOptions & {
    onPartialReply?: Mock;
    flushBlockReplyBuffer?: Mock;
    resetAssistantMessageState?: Mock;
    debug?: Mock;
    shouldEmitPartialReplies?: boolean;
    consumePartialReplyDirectives?: Mock;
    stripBlockTags?: Mock;
    emitReasoningStream?: Mock;
  } = {},
) {
  const directives = createStreamingDirectiveAccumulator();
  const { onAgentEvent, onPartialReply } = params;
  const base = baseContext(params);
  const ctx = {
    ...base,
    params: {
      ...base.params,
      ...(params.onPartialReply ? { onPartialReply: params.onPartialReply } : {}),
    },
    log: { debug: params.debug ?? vi.fn() },
    stripBlockTags: params.stripBlockTags ?? vi.fn((text: string) => text),
    consumePartialReplyDirectives:
      params.consumePartialReplyDirectives ??
      vi.fn((text: string, options?: { final?: boolean }) => directives.consume(text, options)),
    getPartialReplySourceText: () => directives.sourceText,
    emitReasoningStream: params.emitReasoningStream ?? vi.fn(),
    flushBlockReplyBuffer: params.flushBlockReplyBuffer ?? vi.fn(),
    flushAssistantStream: vi.fn(),
    resetAssistantMessageState:
      params.resetAssistantMessageState ?? vi.fn(() => directives.reset()),
    resetPartialReplyDirectives: () => {
      directives.reset();
      ctx.state.lastAssistantAudioDirectiveCount = 0;
      ctx.state.pendingAssistantReplyDirectives = undefined;
    },
    emitAssistantStreamData: vi.fn<EmbeddedAgentSubscribeContext["emitAssistantStreamData"]>(
      (data, options) => {
        onAgentEvent?.({ stream: "assistant", data });
        if (options?.emitPartialReply === true && (params.shouldEmitPartialReplies ?? true)) {
          onPartialReply?.(data);
        }
      },
    ),
  } as unknown as EmbeddedAgentSubscribeContext;
  ctx.state = Object.assign(new EmbeddedAgentSubscribeState(ctx.params), {
    shouldEmitPartialReplies: params.shouldEmitPartialReplies ?? true,
    ...params.state,
  });
  return ctx;
}

export function createMessageEndContext(
  params: ContextOptions & {
    onBlockReply?: Mock;
    finalizeAssistantTexts?: Mock<EmbeddedAgentSubscribeContext["finalizeAssistantTexts"]>;
    warn?: Mock;
    builtinToolNames?: ReadonlySet<string>;
    enforceFinalTag?: boolean;
    bufferedText?: string;
  } = {},
) {
  // Buffered cases seed the real source buffer; other cases exercise terminal-only delivery.
  const base = baseContext(params);
  const ctx = {
    ...base,
    params: {
      ...base.params,
      ...(params.enforceFinalTag !== undefined ? { enforceFinalTag: params.enforceFinalTag } : {}),
      onBlockReply: params.onBlockReply ?? vi.fn(),
    },
    log: { debug: vi.fn(), info: vi.fn(), warn: params.warn ?? vi.fn() },
    builtinToolNames: params.builtinToolNames,
  } as unknown as EmbeddedAgentSubscribeContext;
  ctx.state = Object.assign(new EmbeddedAgentSubscribeState(ctx.params), {
    blockReplyBreak: "message_end",
    ...params.state,
  });
  ctx.blockChunker.append(params.bufferedText ?? "");
  const delivery = createReplyDelivery(ctx);
  ctx.emitAssistantStreamData = delivery.emitAssistantStreamData;
  ctx.flushAssistantStream = delivery.flushAssistantStream;
  ctx.emitBlockReply = vi.fn(delivery.emitBlockReply);
  ctx.finalizeAssistantTexts =
    params.finalizeAssistantTexts ?? vi.fn(delivery.finalizeAssistantTexts);
  const rendering = createStreamRendering({
    ...ctx,
    pendingBlockReplyTasks: delivery.pendingBlockReplyTasks,
    pushAssistantText: delivery.pushAssistantText,
    shouldSkipAssistantText: delivery.shouldSkipAssistantText,
  });
  Object.assign(ctx, rendering);
  return ctx;
}

export function firstMockArg(mock: { mock: { calls: unknown[][] } }, label: string): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call[0];
}

export function createMessageToolEnvelope(
  message: string,
  args: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    name: "message",
    arguments: { action: "send", message, ...args },
  });
}
