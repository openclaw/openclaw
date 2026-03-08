import type { AgentMessage } from "@mariozechner/pi-agent-core";

export function withMessagesContext(
  context: unknown,
  messages: AgentMessage[],
): { messages: AgentMessage[] } & Record<string, unknown> {
  if (!context || typeof context !== "object") {
    return { messages };
  }
  return Object.assign({}, context as Record<string, unknown>, { messages });
}
