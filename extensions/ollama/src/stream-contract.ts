// Lightweight stream constants used before the Ollama transport is activated.
export const OLLAMA_INCOMPLETE_STREAM_ERROR = "Ollama API stream ended without a final response";

export function resolveOllamaStopReason(response: {
  done_reason?: string;
  message: { tool_calls?: readonly unknown[] };
}) {
  // Ollama's length terminal means generation hit its token limit, even when
  // the partial response already contains a complete-looking tool call.
  if (response.done_reason === "length") {
    return "length" as const;
  }
  if (response.message.tool_calls?.length) {
    return "toolUse" as const;
  }
  return "stop" as const;
}
