import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import type { CodexThreadItem } from "./app-server/protocol.js";
import { projectCodexUserItemText } from "./app-server/transcript-history-projection.js";

const CODEX_MESSAGE_TYPES = new Map<string, SessionCatalogTranscriptItem["type"]>([
  ["userMessage", "userMessage"],
  ["agentMessage", "agentMessage"],
  ["reasoning", "reasoning"],
]);

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
  let type = CODEX_MESSAGE_TYPES.get(item.type);
  if (!type && CODEX_TOOL_TYPES.has(item.type)) {
    const hasResult =
      item.status !== "inProgress" &&
      (item.status === "completed" ||
        item.status === "failed" ||
        item.status === "declined" ||
        item.exitCode != null ||
        typeof item.success === "boolean" ||
        item.error != null ||
        (item.result != null && item.result !== "") ||
        item.type === "imageView" ||
        (item.type === "webSearch" && (item.action != null || item.results != null)) ||
        Boolean(item.aggregatedOutput));
    type = hasResult ? "toolResult" : "toolCall";
  }
  type ??= "other";
  const fallback = item.title ?? item.name ?? item.tool ?? item.command ?? item.query ?? undefined;
  const resultText =
    item.error?.message ??
    item.aggregatedOutput ??
    (item.result == null ? undefined : JSON.stringify(item.result, null, 2)) ??
    (item.contentItems == null ? undefined : JSON.stringify(item.contentItems, null, 2)) ??
    (item.type === "webSearch" && item.results != null
      ? JSON.stringify(item.results, null, 2)
      : undefined);
  // File changes carry only a changes array; keep their edits visible.
  const changesText = Array.isArray(item.changes)
    ? item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n") || undefined
    : undefined;
  const text =
    item.type === "userMessage"
      ? projectCodexUserItemText(item)
      : item.text || (resultText ?? changesText ?? (type === "toolResult" ? "" : fallback));
  return {
    id: item.id,
    type,
    ...(text !== undefined ? { text } : {}),
    ...(type === "toolCall" || type === "toolResult" ? toolIdentity(item, type) : {}),
    raw: item as SessionCatalogTranscriptItem["raw"],
  };
}

/** History upserts the completed tool into its original item, retaining input and output. */
function toolIdentity(
  item: CodexThreadItem,
  type: "toolCall" | "toolResult",
): Partial<SessionCatalogTranscriptItem> {
  const toolName =
    item.type === "commandExecution"
      ? "shell"
      : item.type === "fileChange"
        ? "apply_patch"
        : (item.tool ?? item.name ?? item.type);
  const failed =
    item.error != null ||
    (typeof item.exitCode === "number" && item.exitCode !== 0) ||
    item.status === "failed" ||
    item.status === "declined" ||
    item.success === false;
  return {
    toolName,
    toolCallId: item.id,
    toolInput: toolInputOf(item),
    ...(type === "toolResult" && typeof item.exitCode === "number"
      ? { exitCode: item.exitCode }
      : {}),
    ...(type === "toolResult" && failed ? { isError: true } : {}),
  };
}

function toolInputOf(item: CodexThreadItem): SessionCatalogTranscriptItem["toolInput"] {
  if (item.type === "commandExecution") {
    return {
      command: item.command ?? "",
      ...(item.cwd ? { cwd: item.cwd } : {}),
    };
  }
  if (item.type === "fileChange") {
    return { changes: Array.isArray(item.changes) ? item.changes : [] };
  }
  if (item.type === "webSearch") {
    return { query: item.query ?? "" };
  }
  if (item.type === "imageView" && typeof item.path === "string") {
    return { path: item.path };
  }
  return item.arguments === undefined ? {} : item.arguments;
}
