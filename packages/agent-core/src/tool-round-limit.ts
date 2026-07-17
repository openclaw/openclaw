import type { AssistantMessage, ToolResultMessage } from "../../llm-core/src/index.js";
import type { AgentEventSink } from "./agent-loop.js";
import type { AgentContext, AgentMessage, AgentToolCall } from "./types.js";

export async function stopAtToolRoundLimit(
  toolCalls: AgentToolCall[],
  context: AgentContext,
  newMessages: AgentMessage[],
  assistantMessage: AssistantMessage,
  emit: AgentEventSink,
): Promise<void> {
  const toolResults: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Tool-calling round limit reached." }],
      details: {},
      isError: true,
      timestamp: Date.now(),
    };
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
    toolResults.push(message);
    context.messages.push(message);
    newMessages.push(message);
  }
  await emit({ type: "turn_end", message: assistantMessage, toolResults });
  await emit({ type: "agent_end", messages: newMessages });
}
