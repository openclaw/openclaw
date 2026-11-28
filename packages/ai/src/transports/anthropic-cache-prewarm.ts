import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";

/**
 * Anthropic answers `max_tokens: 0` only without streaming, and refuses it when the request
 * implies output: budget thinking, a forced tool, or structured output. Changing any of those
 * would change the cached prefix, so a prewarm keeps the request and refuses instead.
 */
export function assertAnthropicPrewarmable(body: MessageCreateParamsStreaming): void {
  const toolChoice = body.tool_choice?.type;
  if (body.thinking?.type === "enabled") {
    throw new Error("Anthropic cache prewarm is not available with budget thinking.");
  }
  if (toolChoice === "any" || toolChoice === "tool") {
    throw new Error("Anthropic cache prewarm is not available with a forced tool choice.");
  }
  if (body.output_config?.format) {
    throw new Error("Anthropic cache prewarm is not available with structured output.");
  }
}

/** A non-streamed message as the stream events the reducer already reads. */
export function anthropicMessageEvents(message: Record<string, unknown>): object[] {
  return [
    { type: "message_start", message: { ...message, content: [] } },
    { type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage },
    { type: "message_stop" },
  ];
}
