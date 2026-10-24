import { projectRecordedModelPrompt } from "../../sessions/user-turn-transcript.message.js";
import type { AgentMessage } from "../runtime/index.js";

export function extractMessageText(message: AgentMessage): string {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") {
    return content.trim();
  }
  return Array.isArray(content)
    ? content
        .flatMap((block) => {
          const text =
            block && typeof block === "object" && "text" in block ? block.text : undefined;
          return typeof text === "string" && text.trim() ? [text.trim()] : [];
        })
        .join("\n")
    : "";
}

export function hasProjectedSummaryText(messages: AgentMessage[]): boolean {
  // Canonical excerpts cannot preserve document text captured only in a
  // model projection, even when all turns fit the preserved-excerpt count.
  return messages.some(
    (message) =>
      extractMessageText(projectRecordedModelPrompt(message)) !== extractMessageText(message),
  );
}
