export function makeUserMessage(content: string, timestamp: number) {
  return { role: "user" as const, content, timestamp };
}

export function makeTextToolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  isError: boolean,
  timestamp: number,
) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName,
    content: [{ type: "text" as const, text }],
    isError,
    timestamp,
  };
}
