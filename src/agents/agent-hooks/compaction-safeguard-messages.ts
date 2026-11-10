import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  extractCompactionMessageText as extractMessageText,
  formatCompactionUserLabel,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { AgentMessage } from "../runtime/index.js";

const MAX_RECENT_TURN_TEXT_CHARS = 600;

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = (block as { type?: unknown }).type;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") {
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}

export function formatContextMessage(message: AgentMessage): string | null {
  let roleLabel: string;
  if (message.role === "assistant") {
    roleLabel = "Assistant";
  } else if (message.role === "user") {
    roleLabel = formatCompactionUserLabel(message);
  } else if (message.role === "toolResult") {
    const toolName = (message as { toolName?: unknown }).toolName;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [
    extractMessageText(message),
    formatNonTextPlaceholder((message as { content?: unknown }).content),
  ]
    .filter(Boolean)
    .join("\n");
  if (!rendered) {
    return null;
  }
  const trimmed =
    rendered.length > MAX_RECENT_TURN_TEXT_CHARS
      ? `${truncateUtf16Safe(rendered, MAX_RECENT_TURN_TEXT_CHARS)}...`
      : rendered;
  return `- ${roleLabel}: ${trimmed}`;
}
