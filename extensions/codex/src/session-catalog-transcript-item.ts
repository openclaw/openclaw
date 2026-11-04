import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import {
  auditNativeToolName,
  auditNativeToolTerminalStatus,
  itemName,
  itemStatus,
} from "./app-server/event-projector-items.js";
import {
  itemToolArgs,
  itemToolResult,
  itemTranscriptResultText,
  projectCodexToolActivity,
} from "./app-server/event-projector-tool-items.js";
import { collectDynamicToolContentText } from "./app-server/event-projector-tool-output.js";
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
function catalogItemType(item: CodexThreadItem): SessionCatalogTranscriptItem["type"] {
  if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "reasoning") {
    return item.type;
  }
  if (!CODEX_TOOL_TYPES.has(item.type)) {
    return "other";
  }
  const hasResult =
    itemStatus(item) !== "running" &&
    (auditNativeToolTerminalStatus(item) !== "unknown" ||
      item.exitCode != null ||
      typeof item.success === "boolean" ||
      item.error != null ||
      (item.result != null && item.result !== "") ||
      item.contentItems != null ||
      item.aggregatedOutput != null);
  return hasResult ? "toolResult" : "toolCall";
}

export function toGenericTranscriptItem(item: CodexThreadItem): SessionCatalogTranscriptItem {
  const type = catalogItemType(item);
  const fallback = item.title ?? item.name ?? item.tool ?? item.command ?? item.query;
  const resultText =
    item.error?.message ??
    item.aggregatedOutput ??
    (item.result == null ? undefined : JSON.stringify(item.result, null, 2)) ??
    (item.contentItems == null ? undefined : collectDynamicToolContentText(item.contentItems));
  // File changes carry only a changes array; keep their edits visible.
  const changesText =
    item.type === "fileChange" && Array.isArray(item.changes)
      ? itemTranscriptResultText(item)
      : undefined;
  const text =
    item.type === "userMessage"
      ? projectCodexUserItemText(item)
      : item.type === "reasoning"
        ? item.text || reasoningText(item)
        : item.text || (resultText ?? changesText ?? (type === "toolResult" ? "" : fallback));
  return {
    id: item.id,
    type,
    ...(text != null ? { text } : {}),
    raw: item as SessionCatalogTranscriptItem["raw"],
  };
}

/** Gateway display facts; node source pages retain their released wire shape. */
export function codexCatalogDisplayFacts(item: CodexThreadItem): SessionCatalogTranscriptItem {
  const type = catalogItemType(item);
  if (type !== "toolCall" && type !== "toolResult") {
    return item.type === "agentMessage" &&
      (item.phase === "commentary" ||
        item.phase === "final_answer" ||
        item.phase === "partial_answer")
      ? { type, phase: item.phase }
      : { type };
  }
  const activity = projectCodexToolActivity(item, "history");
  const toolInput =
    itemToolArgs(item) ??
    (item.arguments !== undefined
      ? item.arguments
      : item.type === "imageView" && typeof item.path === "string"
        ? { path: item.path }
        : undefined);
  const toolDetails = type === "toolResult" ? itemToolResult(item) : undefined;
  return {
    type,
    toolName: itemName(item) ?? auditNativeToolName(item) ?? item.tool ?? item.name ?? item.type,
    toolCallId: item.id,
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(activity
      ? { activity: { ...activity, ...(type === "toolCall" ? { unpairedCall: true } : {}) } }
      : {}),
    ...(toolDetails !== undefined ? { toolDetails } : {}),
    ...(type === "toolResult" && typeof item.exitCode === "number"
      ? { exitCode: item.exitCode }
      : {}),
    ...(type === "toolResult" && activity?.status
      ? { isError: activity.status === "failed" || activity.status === "blocked" }
      : {}),
  };
}

function reasoningText(item: CodexThreadItem): string | undefined {
  const text = [item.summary, item.content]
    .flatMap((sections) => (Array.isArray(sections) ? sections : []))
    .filter(
      (section): section is string => typeof section === "string" && section.trim().length > 0,
    )
    .join("\n\n");
  return text || undefined;
}
