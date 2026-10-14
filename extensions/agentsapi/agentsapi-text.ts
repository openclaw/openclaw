import type { AgentsApiItem } from "./agentsapi-client.js";

export function readAgentsApiFinalText(items: readonly AgentsApiItem[]): string {
  const completedMessages = items.filter(
    (item) => item.type === "message" && item.role === "assistant" && item.status === "completed",
  );
  const finalItems = completedMessages.filter((item) => item.phase === "final_answer");
  const visibleItems = finalItems.length
    ? finalItems
    : completedMessages.filter((item) => item.phase !== "commentary");
  return visibleItems
    .map(
      (item) =>
        item.content
          ?.filter((part) => part.type === "output_text")
          .map((part) => part.text ?? "")
          .join("") ?? "",
    )
    .join("\n");
}
