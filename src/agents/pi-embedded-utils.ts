import type { AssistantMessage } from "@mariozechner/pi-ai";
import { formatToolDetail, resolveToolDisplay } from "./tool-display.js";

export function extractAssistantText(msg: AssistantMessage): string {
  const isTextBlock = (
    block: unknown,
  ): block is { type: "text"; text: string } => {
    if (!block || typeof block !== "object") return false;
    const rec = block as Record<string, unknown>;
    return rec.type === "text" && typeof rec.text === "string";
  };

  const blocks = Array.isArray(msg.content)
    ? msg.content
        .filter(isTextBlock)
        .map((c) => c.text.trim())
        .filter(Boolean)
    : [];
  return blocks.join("\n").trim();
}

export function inferToolMetaFromArgs(
  toolName: string,
  args: unknown,
): string | undefined {
  const display = resolveToolDisplay({ name: toolName, args });
  return formatToolDetail(display);
}
