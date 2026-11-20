import type { AssistantMessage } from "../llm/types.js";
import type { SessionManager } from "./sessions/session-manager.js";

/**
 * A tool call still running at the fork's anchor gets a non-error result saying so, so the
 * fork does not read the call as failed. The model view has no persistence target: these
 * results exist only in the fork.
 */
export async function markRunningToolCalls(manager: SessionManager): Promise<void> {
  // The latest batch is the last assistant message plus the tool results recorded after it.
  const completed = new Set<string>();
  let batch: AssistantMessage | undefined;
  for (const entry of manager.getBranch().toReversed()) {
    if (entry.type !== "message") {
      continue;
    }
    if (entry.message.role === "toolResult") {
      completed.add(entry.message.toolCallId);
      continue;
    }
    batch = entry.message.role === "assistant" ? entry.message : undefined;
    break;
  }
  for (const block of batch?.content ?? []) {
    if (block.type === "toolCall" && !completed.has(block.id)) {
      await manager.appendMessageAsync({
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [
          {
            type: "text",
            text: "This tool call is still running. Its result is not available yet.",
          },
        ],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
}
