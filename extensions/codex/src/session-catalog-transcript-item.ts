import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import type { CodexThreadItem } from "./app-server/protocol.js";
import { projectCodexUserItemText } from "./app-server/transcript-history-projection.js";

const CODEX_TOOL_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

export function toGenericTranscriptItem(item: CodexThreadItem): SessionCatalogTranscriptItem {
  let type: SessionCatalogTranscriptItem["type"] = "other";
  if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "reasoning") {
    type = item.type;
  } else if (CODEX_TOOL_TYPES.has(item.type)) {
    type = item.result !== undefined || item.aggregatedOutput ? "toolResult" : "toolCall";
  }
  const fallback = item.title ?? item.name ?? item.tool ?? item.command ?? item.query;
  const resultText =
    item.aggregatedOutput ||
    (item.result === undefined ? undefined : JSON.stringify(item.result, null, 2));
  // File changes carry only a changes array; keep their edits visible.
  const changesText = Array.isArray(item.changes)
    ? item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n") || undefined
    : undefined;
  const text =
    item.type === "userMessage"
      ? projectCodexUserItemText(item)
      : item.text || resultText || changesText || fallback;
  return {
    id: item.id,
    type,
    ...(text ? { text } : {}),
    raw: item as SessionCatalogTranscriptItem["raw"],
  };
}
