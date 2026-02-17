/**
 * Consumes the claude-agent-sdk's async generator (`query()`) and produces
 * the same callback outputs that `subscribeEmbeddedPiSession()` provides.
 *
 * This adapter maps SDK message types to openclaw's streaming event model:
 * - `stream_event` (content_block_delta) -> onBlockReply, onPartialReply, onReasoningStream
 * - `assistant` (complete message) -> assistantTexts, toolMetas
 * - `result` (final outcome) -> usage, errors
 * - `system` (init, compact_boundary) -> sessionId, compactionCount
 */

import type {
  SDKAssistantMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
/** Extracted from SDKPartialAssistantMessage.event to avoid direct @anthropic-ai/sdk import. */
type StreamEvent = SDKPartialAssistantMessage["event"];
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ReasoningLevel } from "../../auto-reply/thinking.js";
import type { BlockReplyChunking } from "../pi-embedded-block-chunker.js";
import { EmbeddedBlockChunker } from "../pi-embedded-block-chunker.js";
import type { MessagingToolSend } from "../pi-embedded-messaging.js";
import type { NormalizedUsage } from "../usage.js";
import type { SdkStreamResult } from "./types.js";

export type ConsumeStreamParams = {
  queryIterator: Query;
  reasoningMode?: ReasoningLevel;
  onBlockReply?: (payload: {
    text?: string;
    mediaUrls?: string[];
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }) => void | Promise<void>;
  onBlockReplyFlush?: () => void | Promise<void>;
  blockReplyBreak?: "text_end" | "message_end";
  blockReplyChunking?: BlockReplyChunking;
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onReasoningStream?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
  enforceFinalTag?: boolean;
  abortSignal?: AbortSignal;
};

// Minimal thinking tag scanner
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi;

function stripThinkingTags(text: string): string {
  let result = "";
  let inThinking = false;
  let lastIndex = 0;

  for (const match of text.matchAll(THINKING_TAG_RE)) {
    const isClosing = match[1] === "/";
    if (!inThinking && !isClosing) {
      // Opening tag: capture text before it
      result += text.slice(lastIndex, match.index);
      inThinking = true;
    } else if (inThinking && isClosing) {
      // Closing tag: skip everything inside
      inThinking = false;
    }
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  if (!inThinking) {
    result += text.slice(lastIndex);
  }
  return result;
}

/**
 * Consume the SDK's async generator and produce a SdkStreamResult.
 */
export async function consumeSdkStream(params: ConsumeStreamParams): Promise<SdkStreamResult> {
  const assistantTexts: string[] = [];
  const toolMetas: Array<{ toolName: string; meta?: string }> = [];
  const messagingToolSentTexts: string[] = [];
  const messagingToolSentMediaUrls: string[] = [];
  const messagingToolSentTargets: MessagingToolSend[] = [];

  let sessionId = "";
  let lastAssistant: AssistantMessage | undefined;
  let lastToolError: SdkStreamResult["lastToolError"] = undefined;
  let didSendViaMessagingTool = false;
  let successfulCronAdds = 0;
  let usage: NormalizedUsage | undefined;
  let compactionCount = 0;
  let aborted = false;
  let timedOut = false;
  let error: unknown = null;

  // Block chunker for splitting streamed text into blocks for channel delivery
  const blockChunker = params.blockReplyChunking
    ? new EmbeddedBlockChunker(params.blockReplyChunking)
    : null;

  // Accumulated text for the current assistant turn
  let currentAssistantText = "";
  let currentThinkingText = "";
  let isInThinking = false;

  const emitBlockChunk = (text: string) => {
    if (!params.onBlockReply) {
      return;
    }
    if (blockChunker) {
      blockChunker.append(text);
      blockChunker.drain({
        force: false,
        emit: (chunk) => params.onBlockReply!({ text: chunk }),
      });
    } else {
      void params.onBlockReply({ text });
    }
  };

  const flushBlockChunker = () => {
    if (!blockChunker || !params.onBlockReply) {
      return;
    }
    blockChunker.drain({
      force: true,
      emit: (chunk) => params.onBlockReply!({ text: chunk }),
    });
  };

  try {
    for await (const message of params.queryIterator) {
      if (params.abortSignal?.aborted) {
        aborted = true;
        break;
      }

      switch (message.type) {
        case "system": {
          const sysMsg = message as SDKSystemMessage & { subtype: string };
          if (sysMsg.subtype === "init") {
            sessionId = sysMsg.session_id;
          } else if (sysMsg.subtype === "compact_boundary") {
            compactionCount++;
          }
          break;
        }

        case "stream_event": {
          const partial = message;
          const event = partial.event;
          handleStreamEvent(event);
          break;
        }

        case "assistant": {
          const assistantMsg = message;
          handleAssistantMessage(assistantMsg);
          break;
        }

        case "result": {
          handleResult(message);
          break;
        }

        case "tool_progress": {
          // Tool execution progress - emit as agent event for UI tracking
          const toolProgress = message as {
            tool_use_id: string;
            tool_name: string;
            elapsed_time_seconds: number;
          };
          if (params.onAgentEvent) {
            void params.onAgentEvent({
              stream: "tool_execution_update",
              data: {
                toolName: toolProgress.tool_name,
                toolCallId: toolProgress.tool_use_id,
                elapsed: toolProgress.elapsed_time_seconds,
              },
            });
          }
          break;
        }

        default:
          // Other message types (user, user replay, auth_status, etc.) are
          // not directly relevant to the streaming output.
          break;
      }
    }
  } catch (err) {
    if (params.abortSignal?.aborted) {
      aborted = true;
    } else {
      error = err;
    }
  }

  // Flush any remaining text in the block chunker
  flushBlockChunker();

  return {
    sessionId,
    aborted,
    timedOut,
    error,
    assistantTexts,
    toolMetas,
    lastAssistant,
    lastToolError,
    didSendViaMessagingTool,
    messagingToolSentTexts,
    messagingToolSentMediaUrls,
    messagingToolSentTargets,
    successfulCronAdds,
    usage,
    compactionCount,
  };

  // ── Stream event handler ─────────────────────────────────────────────

  function handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case "message_start":
        currentAssistantText = "";
        currentThinkingText = "";
        isInThinking = false;
        void params.onAssistantMessageStart?.();
        break;

      case "content_block_start": {
        const block = (event as unknown as { content_block: { type: string } }).content_block;
        if (block?.type === "thinking") {
          isInThinking = true;
          currentThinkingText = "";
        }
        break;
      }

      case "content_block_delta": {
        const delta = (
          event as unknown as { delta: { type: string; text?: string; thinking?: string } }
        ).delta;
        if (delta.type === "text_delta" && delta.text) {
          const cleaned = stripThinkingTags(delta.text);
          if (cleaned) {
            currentAssistantText += cleaned;
            emitBlockChunk(cleaned);
            void params.onPartialReply?.({ text: currentAssistantText });
          }
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          currentThinkingText += delta.thinking;
          if (params.reasoningMode === "stream") {
            void params.onReasoningStream?.({ text: delta.thinking });
          }
        }
        break;
      }

      case "content_block_stop": {
        if (isInThinking) {
          isInThinking = false;
          void params.onReasoningEnd?.();
        }
        break;
      }

      case "message_stop":
      case "message_delta":
        // These are handled at the `assistant` message level.
        break;

      default:
        break;
    }
  }

  // ── Complete assistant message handler ────────────────────────────────

  function handleAssistantMessage(msg: SDKAssistantMessage) {
    const content = msg.message?.content;
    if (!content || !Array.isArray(content)) {
      return;
    }

    let text = "";
    for (const block of content) {
      if (block.type === "text") {
        text += (block as { type: "text"; text: string }).text;
      } else if (block.type === "tool_use") {
        const toolBlock = block as { type: "tool_use"; id: string; name: string; input: unknown };
        toolMetas.push({
          toolName: toolBlock.name,
          meta:
            typeof toolBlock.input === "object"
              ? JSON.stringify(toolBlock.input).slice(0, 200)
              : undefined,
        });

        // Track messaging tool usage
        if (isMessagingTool(toolBlock.name)) {
          const input = toolBlock.input as Record<string, unknown>;
          if (typeof input.message === "string" && input.message.trim()) {
            didSendViaMessagingTool = true;
            messagingToolSentTexts.push(input.message);
          }
          if (typeof input.mediaUrl === "string") {
            messagingToolSentMediaUrls.push(input.mediaUrl);
          }
        }

        // Track cron adds
        if (toolBlock.name === "cron" || toolBlock.name === "mcp__openclaw__cron") {
          const input = toolBlock.input as Record<string, unknown>;
          if (input.action === "add") {
            successfulCronAdds++;
          }
        }
      }
    }

    const cleaned = stripThinkingTags(text).trim();
    if (cleaned) {
      assistantTexts.push(cleaned);
    }

    // Map to pi-mono AssistantMessage shape for compatibility
    const msgUsage = msg.message?.usage;
    lastAssistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      stopReason: msg.error ? "error" : "stop",
      errorMessage: msg.error ?? undefined,
      usage: {
        input: msgUsage?.input_tokens ?? 0,
        output: msgUsage?.output_tokens ?? 0,
        cacheRead: msgUsage?.cache_read_input_tokens ?? 0,
        cacheWrite: msgUsage?.cache_creation_input_tokens ?? 0,
        totalTokens:
          (msgUsage?.input_tokens ?? 0) +
          (msgUsage?.output_tokens ?? 0) +
          (msgUsage?.cache_read_input_tokens ?? 0) +
          (msgUsage?.cache_creation_input_tokens ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      provider: "anthropic",
      model: msg.message?.model ?? "",
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
  }

  // ── Result handler ───────────────────────────────────────────────────

  function handleResult(result: SDKResultMessage) {
    sessionId = result.session_id;

    if (result.subtype === "success") {
      // Map usage
      if (result.usage) {
        usage = {
          input: result.usage.input_tokens || undefined,
          output: result.usage.output_tokens || undefined,
          cacheRead: result.usage.cache_read_input_tokens || undefined,
          cacheWrite: result.usage.cache_creation_input_tokens || undefined,
          total:
            (result.usage.input_tokens || 0) +
              (result.usage.output_tokens || 0) +
              (result.usage.cache_read_input_tokens || 0) +
              (result.usage.cache_creation_input_tokens || 0) || undefined,
        };
      }
    } else {
      // Error result
      const errorResult = result as SDKResultMessage & { errors?: string[] };
      const errorMessage =
        Array.isArray(errorResult.errors) && errorResult.errors.length > 0
          ? errorResult.errors.join("; ")
          : `SDK run ended with: ${result.subtype}`;

      if (result.subtype === "error_max_turns") {
        timedOut = true;
      }

      error = new Error(errorMessage);

      // Map usage even on error
      if (result.usage) {
        usage = {
          input: result.usage.input_tokens || undefined,
          output: result.usage.output_tokens || undefined,
          cacheRead: result.usage.cache_read_input_tokens || undefined,
          cacheWrite: result.usage.cache_creation_input_tokens || undefined,
          total:
            (result.usage.input_tokens || 0) +
              (result.usage.output_tokens || 0) +
              (result.usage.cache_read_input_tokens || 0) +
              (result.usage.cache_creation_input_tokens || 0) || undefined,
        };
      }
    }
  }
}

/** Messaging tool names that indicate the agent sent a message to the channel. */
function isMessagingTool(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("send_message") ||
    lower.includes("sendmessage") ||
    lower.includes("thread_reply") ||
    lower.includes("sessions_send") ||
    lower === "mcp__openclaw__send_message" ||
    lower === "mcp__openclaw__thread_reply" ||
    lower === "mcp__openclaw__sessions_send"
  );
}
