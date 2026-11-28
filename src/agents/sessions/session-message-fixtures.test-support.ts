export const text = (value: string) => [{ type: "text" as const, text: value }];

export function toolResult(value: string, toolCallId = "call", timestamp = 0) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: "read",
    isError: false,
    content: text(value),
    timestamp,
  };
}
