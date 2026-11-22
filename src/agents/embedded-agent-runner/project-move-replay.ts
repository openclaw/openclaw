import type { AgentMessage } from "../runtime/index.js";

/** Describe the retired move tool in the model's history without teaching a text tool-call syntax. */
export function describePastProjectMoves(messages: AgentMessage[]): AgentMessage[] {
  let projected: AgentMessage[] | undefined;
  let assistantIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "toolResult") {
      assistantIndex = message.role === "assistant" ? (projected?.length ?? index) : -1;
    } else if (
      message.toolName === "session_project" &&
      message.content.length === 1 &&
      message.content[0]?.type === "text"
    ) {
      // Parallel results belong to the preceding assistant, even if another tool finished first.
      const assistant = (projected ?? messages)[assistantIndex];
      if (assistant?.role === "assistant") {
        const call = assistant.content.find(
          (block) => block.type === "toolCall" && block.id === message.toolCallId,
        );
        if (
          call?.type === "toolCall" &&
          call.name === message.toolName &&
          call.arguments?.action === "move"
        ) {
          const text = `Earlier project move request: ${JSON.stringify(call.arguments)}\nGateway receipt: ${message.content[0].text}`;
          projected ??= messages.slice(0, index);
          projected[assistantIndex] = {
            ...assistant,
            content: assistant.content.map((block) =>
              block === call ? { type: "text", text } : block,
            ),
          };
          continue;
        }
      }
    }
    projected?.push(message);
  }
  return projected ?? messages;
}
