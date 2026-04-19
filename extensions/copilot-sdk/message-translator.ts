import type { OpenAiChatMessage, OpenAiChatRequest, OpenAiContentPart } from "./shared-types.js";

/**
 * Shim-layer error indicating that an OpenAI chat-completions request
 * declared tools / tool_choice but the plugin is configured to reject them.
 *
 * The Copilot CLI acts as a pure LLM in this plugin (permission requests are
 * denied), so it cannot execute OpenClaw's tool calls. Surfacing this as a
 * typed error lets the shim return HTTP 400 with a stable error code rather
 * than silently dropping tool semantics.
 */
export class ToolsNotSupportedError extends Error {
  readonly code = "tools_not_supported";
  constructor() {
    super(
      "The copilot-sdk plugin cannot forward `tools` to @github/copilot CLI. " +
        "Set plugins.entries.copilot-sdk.config.rejectToolRequests=false to allow silent " +
        "degradation, or disable tool use for this model.",
    );
    this.name = "ToolsNotSupportedError";
  }
}

/**
 * Concatenates OpenAI-style chat messages into a single prompt string the
 * Copilot CLI session can consume via `session.sendAndWait({ prompt })`.
 *
 * The Copilot SDK's session API is agent-shaped (single prompt in, streamed
 * assistant events out) rather than completion-shaped (N role-tagged messages
 * in, one completion out). We reconstruct role context by inlining role
 * prefixes; this is lossy but preserves conversational intent well enough for
 * the CLI's model to produce useful completions.
 */
export function openAiMessagesToPrompt(messages: OpenAiChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    const text = extractText(message.content);
    if (!text) {
      continue;
    }
    const role = message.role ?? "user";
    if (role === "system") {
      parts.push(`[system]\n${text}`);
    } else if (role === "user") {
      parts.push(`[user]\n${text}`);
    } else if (role === "assistant") {
      parts.push(`[assistant]\n${text}`);
    } else if (role === "tool") {
      parts.push(`[tool:${message.name ?? message.tool_call_id ?? "result"}]\n${text}`);
    } else {
      parts.push(`[${role}]\n${text}`);
    }
  }
  return parts.join("\n\n").trim();
}

function extractText(content: OpenAiChatMessage["content"]): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  const pieces: string[] = [];
  for (const part of content) {
    const text = extractTextFromPart(part);
    if (text) {
      pieces.push(text);
    }
  }
  return pieces.join("\n");
}

function extractTextFromPart(part: OpenAiContentPart): string {
  if (!part || typeof part !== "object") {
    return "";
  }
  if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
    return (part as { text: string }).text;
  }
  if (part.type === "image_url") {
    // Images are not forwarded by this shim; emit a placeholder so the model
    // knows the user referenced an image without us hallucinating its content.
    return "[image attachment elided by copilot-sdk shim]";
  }
  return "";
}

/**
 * Returns true when the request asks for capabilities this shim cannot honor
 * without silently degrading. Callers should translate this into a
 * `ToolsNotSupportedError` when rejection is enabled.
 */
export function requestDeclaresTools(request: OpenAiChatRequest): boolean {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    return true;
  }
  if (
    request.tool_choice !== undefined &&
    request.tool_choice !== null &&
    request.tool_choice !== "none"
  ) {
    return true;
  }
  return false;
}

/**
 * Builds a non-streaming OpenAI chat-completions response body from a model id
 * and plain assistant text. `created` is an optional override for test
 * determinism.
 */
export function buildChatCompletionResponse(options: {
  model: string;
  content: string;
  created?: number;
  id?: string;
  finishReason?: "stop" | "length";
}): Record<string, unknown> {
  const created = options.created ?? Math.floor(Date.now() / 1000);
  return {
    id: options.id ?? `chatcmpl-copilot-sdk-${created}`,
    object: "chat.completion",
    created,
    model: options.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: options.content },
        finish_reason: options.finishReason ?? "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Builds the two SSE chunks that make up a streaming response whose body is a
 * single assistant message (since the Copilot SDK only emits whole messages,
 * not per-token deltas). Returned as string array rather than a stream so
 * callers can decide how to flush.
 */
export function buildChatCompletionStreamChunks(options: {
  model: string;
  content: string;
  created?: number;
  id?: string;
}): string[] {
  const created = options.created ?? Math.floor(Date.now() / 1000);
  const id = options.id ?? `chatcmpl-copilot-sdk-${created}`;
  const base = { id, object: "chat.completion.chunk", created, model: options.model };
  const deltaChunk = {
    ...base,
    choices: [
      { index: 0, delta: { role: "assistant", content: options.content }, finish_reason: null },
    ],
  };
  const doneChunk = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return [
    `data: ${JSON.stringify(deltaChunk)}\n\n`,
    `data: ${JSON.stringify(doneChunk)}\n\n`,
    "data: [DONE]\n\n",
  ];
}
