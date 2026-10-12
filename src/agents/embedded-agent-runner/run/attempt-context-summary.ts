import type { AgentMessage } from "../../runtime/index.js";

const MAX_BTW_SNAPSHOT_MESSAGES = 100;

export function summarizeSessionContext(messages: AgentMessage[]): {
  roleCounts: string;
  totalTextChars: number;
  totalImageBlocks: number;
  maxMessageTextChars: number;
} {
  const roleCounts = new Map<string, number>();
  let totalTextChars = 0;
  let totalImageBlocks = 0;
  let maxMessageTextChars = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

    const content = (msg as { content?: unknown }).content;
    let textChars = typeof content === "string" ? content.length : 0;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typedBlock = block as { type?: unknown; text?: unknown };
        if (typedBlock.type === "image") {
          totalImageBlocks++;
        } else if (typeof typedBlock.text === "string") {
          textChars += typedBlock.text.length;
        }
      }
    }
    totalTextChars += textChars;
    maxMessageTextChars = Math.max(maxMessageTextChars, textChars);
  }

  return {
    roleCounts:
      [...roleCounts.entries()]
        .toSorted((a, b) => a[0].localeCompare(b[0]))
        .map(([role, count]) => `${role}:${count}`)
        .join(",") || "none",
    totalTextChars,
    totalImageBlocks,
    maxMessageTextChars,
  };
}

export function snapshotRecentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.slice(-MAX_BTW_SNAPSHOT_MESSAGES);
}
