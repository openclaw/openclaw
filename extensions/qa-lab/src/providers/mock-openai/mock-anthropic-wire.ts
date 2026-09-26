// QA Lab Anthropic Messages wire conversion and response events.
import { createHash } from "node:crypto";
import {
  type ResponsesInputItem,
  type StreamEvent,
  type AnthropicMessageContentBlock,
  type AnthropicMessage,
  type AnthropicMessagesRequest,
  type AnthropicStreamEvent,
  type QaMockProviderFailure,
  countApproxTokens,
  parseJsonObjectBody,
} from "./mock-openai-contracts.js";

export function normalizeAnthropicSystemToString(
  system: AnthropicMessagesRequest["system"],
): string | undefined {
  return stringifyToolResultContent(system).trim() || undefined;
}

function stringifyToolResultContent(
  content: Extract<AnthropicMessageContentBlock, { type: "tool_result" }>["content"] | undefined,
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function convertAnthropicMessagesToResponsesInput(params: {
  system?: AnthropicMessagesRequest["system"];
  messages: AnthropicMessage[];
}): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const systemText = normalizeAnthropicSystemToString(params.system);
  if (systemText) {
    items.push({
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    });
  }
  for (const message of params.messages) {
    const content = message.content;
    if (typeof content === "string") {
      items.push({
        role: message.role,
        content: [
          message.role === "assistant"
            ? { type: "output_text", text: content }
            : { type: "input_text", text: content },
        ],
      });
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }
    // Role messages must precede tool calls and results, or the current-turn
    // extractor will fence out the result as belonging to an older turn.
    const textPieces: Array<{ type: "input_text" | "output_text"; text: string }> = [];
    const imagePieces: Array<{ type: "input_image"; image_url: string }> = [];
    const toolResultItems: ResponsesInputItem[] = [];
    const toolUseItems: ResponsesInputItem[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text") {
        textPieces.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: block.text ?? "",
        });
        continue;
      }
      if (block.type === "image") {
        // Mock only needs to count image inputs; a placeholder URL is fine.
        imagePieces.push({ type: "input_image", image_url: "anthropic-mock:image" });
        continue;
      }
      if (block.type === "tool_result") {
        toolResultItems.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: stringifyToolResultContent(block.content),
          ...(typeof block.is_error === "boolean" ? { is_error: block.is_error } : {}),
        });
        continue;
      }
      if (block.type === "tool_use") {
        toolUseItems.push({
          type: "function_call",
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
          call_id: block.id,
        });
      }
    }
    if (textPieces.length > 0 || imagePieces.length > 0) {
      items.push({ role: message.role, content: [...textPieces, ...imagePieces] });
    }
    // A tool-result-only turn has no user message: it continues the active turn.
    for (const item of [...toolUseItems, ...toolResultItems]) {
      items.push(item);
    }
  }
  return items;
}

type ExtractedAssistantOutput = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
};

const NATIVE_ANTHROPIC_TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_]+$/;
const ANTHROPIC_TOOL_USE_ID_MAX_LENGTH = 64;

function isNativeAnthropicToolUseId(id: string): boolean {
  return id.length <= ANTHROPIC_TOOL_USE_ID_MAX_LENGTH && NATIVE_ANTHROPIC_TOOL_USE_ID_RE.test(id);
}

export function adaptAnthropicToolCallIds(events: StreamEvent[]): StreamEvent[] {
  const adaptedIds = new Map<string, string>();
  const adaptId = (id: string) => {
    if (isNativeAnthropicToolUseId(id)) {
      return id;
    }
    const existing = adaptedIds.get(id);
    if (existing) {
      return existing;
    }
    const adapted = `toolu${createHash("sha256").update(id).digest("hex").slice(0, 35)}`;
    adaptedIds.set(id, adapted);
    return adapted;
  };
  const adaptItem = (item: Record<string, unknown>) => {
    if (
      (item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.call_id === "string"
    ) {
      return { ...item, call_id: adaptId(item.call_id) };
    }
    return item;
  };

  return events.map((event) => {
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      return { ...event, item: adaptItem(event.item) };
    }
    if (event.type === "response.custom_tool_call_input.delta") {
      return { ...event, call_id: adaptId(event.call_id) };
    }
    if (event.type === "response.completed") {
      return {
        ...event,
        response: {
          ...event.response,
          output: event.response.output.map(adaptItem),
        },
      };
    }
    return event;
  });
}

export function extractAssistantOutputFromEvents(events: StreamEvent[]): ExtractedAssistantOutput {
  const toolCalls: ExtractedAssistantOutput["toolCalls"] = [];
  let text = "";
  for (const event of events) {
    // Failed streams may never finish an output item; retain text emitted before failure.
    if (event.type === "response.output_text.delta") {
      text += event.delta;
      continue;
    }
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item;
    if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : `toolu_mock_${toolCalls.length + 1}`,
        name: item.name,
        input:
          typeof item.arguments === "string" ? (parseJsonObjectBody(item.arguments) ?? {}) : {},
      });
      continue;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const piece of item.content as Array<{ type?: unknown; text?: unknown }>) {
        if (piece?.type === "output_text" && typeof piece.text === "string") {
          text = piece.text;
        }
      }
    }
  }
  return { text, toolCalls };
}

export function buildAnthropicMessageResponse(params: {
  model: string;
  extracted: ExtractedAssistantOutput;
}) {
  const content: Array<Extract<AnthropicMessageContentBlock, { type: "text" | "tool_use" }>> = [];
  if (params.extracted.text) {
    content.push({ type: "text", text: params.extracted.text });
  }
  for (const call of params.extracted.toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  const stopReason = params.extracted.toolCalls.length > 0 ? "tool_use" : "end_turn";
  const approxInputTokens = 64;
  const approxOutputTokens = Math.max(
    16,
    countApproxTokens(params.extracted.text) + params.extracted.toolCalls.length * 16,
  );
  return {
    id: `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`,
    type: "message",
    role: "assistant",
    model: params.model || "claude-opus-4-8",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: approxInputTokens,
      output_tokens: approxOutputTokens,
    },
  };
}

export function buildAnthropicFailureResponse(failure: QaMockProviderFailure) {
  return {
    type: "error",
    error: {
      type: failure.type,
      ...(failure.code ? { code: failure.code } : {}),
      message: failure.message,
    },
  };
}

const QA_ANTHROPIC_THINKING_ERROR_TEXT =
  "QA replay-safe read completed, but the provider stream failed after signed thinking.";
const QA_ANTHROPIC_THINKING_ERROR_SIGNATURE = "qa_signed_thinking_block_91953";
const QA_ANTHROPIC_THINKING_ERROR_MESSAGE = "QA injected provider stream failure";

export function buildAnthropicThinkingErrorResponse(params: {
  model: string;
}): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: QA_ANTHROPIC_THINKING_ERROR_MESSAGE,
    },
    model: params.model || "claude-opus-4-8",
  };
}

export function buildAnthropicThinkingErrorStreamEvents(params: {
  model: string;
}): AnthropicStreamEvent[] {
  const messageId = `msg_mock_${Math.floor(Math.random() * 1_000_000).toString(16)}`;
  return [
    {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: params.model || "claude-opus-4-8",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 64,
          output_tokens: 0,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "thinking",
        thinking: "",
        signature: "",
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: QA_ANTHROPIC_THINKING_ERROR_TEXT,
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "signature_delta",
        signature: QA_ANTHROPIC_THINKING_ERROR_SIGNATURE,
      },
    },
    {
      type: "content_block_stop",
      index: 0,
    },
    {
      type: "message_delta",
      delta: {},
      usage: {
        input_tokens: 64,
        output_tokens: 1120,
      },
    },
    {
      type: "error",
      error: {
        type: "api_error",
        message: QA_ANTHROPIC_THINKING_ERROR_MESSAGE,
      },
    },
  ];
}

export function buildAnthropicMessageStreamEvents(
  message: ReturnType<typeof buildAnthropicMessageResponse>,
  failure?: QaMockProviderFailure,
): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [
    {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: 0,
        },
      },
    },
  ];
  for (const [index, block] of message.content.entries()) {
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        ...block,
        ...(block.type === "text" ? { text: "" } : { input: {} }),
      },
    });
    const delta = block.type === "text" ? block.text : JSON.stringify(block.input);
    if (delta) {
      events.push({
        type: "content_block_delta",
        index,
        delta:
          block.type === "text"
            ? { type: "text_delta", text: delta }
            : { type: "input_json_delta", partial_json: delta },
      });
    }
    events.push({
      type: "content_block_stop",
      index,
    });
  }
  if (failure) {
    events.push(buildAnthropicFailureResponse(failure));
    return events;
  }
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: message.stop_reason,
    },
    usage: message.usage,
  });
  events.push({
    type: "message_stop",
  });
  return events;
}
