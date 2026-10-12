import { readStringField as readItemString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexThreadItem } from "./protocol.js";

export type CodexNativeToolAuditStatus = ReturnType<typeof itemStatus> | "cancelled" | "unknown";
export type CodexNativeToolUnfinishedStatus = Extract<
  CodexNativeToolAuditStatus,
  "failed" | "unknown"
>;

type CodexItemMetadata = {
  toolName?: string;
  auditName?: string;
  projectedTool?: true;
  clearsTerminal?: true;
} & (
  | { kind: "tool" | "command" | "patch" | "search" | "analysis"; title: string }
  | { kind?: never; title?: never }
);

type CodexItemStatus = "completed" | "failed" | "running" | "blocked";

const itemStatuses = new Map<string, CodexItemStatus>([
  ["completed", "completed"],
  ["failed", "failed"],
  ["error", "failed"],
  ["interrupted", "failed"],
  ["declined", "blocked"],
  ["inProgress", "running"],
  ["in_progress", "running"],
  ["running", "running"],
]);

const itemMetadata = new Map<string, CodexItemMetadata>([
  ["dynamicToolCall", { kind: "tool", title: "Tool" }],
  ["mcpToolCall", { kind: "tool", title: "MCP tool", projectedTool: true }],
  [
    "commandExecution",
    { kind: "command", title: "Command", toolName: "bash", projectedTool: true },
  ],
  [
    "fileChange",
    { kind: "patch", title: "File change", toolName: "apply_patch", projectedTool: true },
  ],
  [
    "webSearch",
    { kind: "search", title: "Web search", toolName: "web_search", projectedTool: true },
  ],
  ["contextCompaction", { kind: "analysis", title: "Context compaction" }],
  ["reasoning", { kind: "analysis", title: "Reasoning" }],
  ["collabAgentToolCall", { clearsTerminal: true }],
  ["imageGeneration", { auditName: "image_generation", clearsTerminal: true }],
  ["imageView", { auditName: "image_view", clearsTerminal: true }],
  ["sleep", { auditName: "sleep" }],
]);

export function matchesCodexSnapshotTurn(item: CodexThreadItem, turnId: string): boolean {
  // Missing turnId inherits the validated enclosing snapshot; explicit foreign IDs do not.
  const itemTurnId = readItemString(item, "turnId");
  return itemTurnId === undefined || itemTurnId === turnId;
}

export function itemKind(item: CodexThreadItem): CodexItemMetadata["kind"] | undefined {
  return itemMetadata.get(item.type)?.kind;
}

export function itemTitle(item: CodexThreadItem): string {
  return itemMetadata.get(item.type)?.title ?? item.type;
}

export function itemStatus(item: CodexThreadItem): CodexItemStatus {
  return itemStatuses.get(readItemString(item, "status") ?? "") ?? "completed";
}

export function unknownItemStatus(item: CodexThreadItem): string | undefined {
  const status = readItemString(item, "status");
  return status === undefined || itemStatuses.has(status) ? undefined : status;
}

export function auditNativeToolTerminalStatus(item: CodexThreadItem): CodexNativeToolAuditStatus {
  if (item.type === "imageView" || item.type === "sleep") {
    return "completed";
  }
  const status = itemStatuses.get(readItemString(item, "status") ?? "");
  // A completed notification with a missing, active, or new status does not
  // prove success. Preserve that ambiguity at the durable audit boundary.
  return status === undefined || status === "running" ? "unknown" : status;
}

export function auditNativeToolUnfinishedStatus(
  item: CodexThreadItem,
): CodexNativeToolUnfinishedStatus {
  // Search and image generation publish explicit terminal states. An enclosing
  // run outcome cannot substitute when that dependency-owned state is absent.
  return item.type === "webSearch" || item.type === "imageGeneration" ? "unknown" : "failed";
}

export function isNonSuccessItemStatus(status: ReturnType<typeof itemStatus>): boolean {
  return status === "failed" || status === "blocked";
}

export function itemName(item: CodexThreadItem): string | undefined {
  if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
    return item.tool;
  }
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    const server = typeof item.server === "string" ? item.server : undefined;
    return server ? `${server}.${item.tool}` : item.tool;
  }
  return itemMetadata.get(item.type)?.toolName;
}

export function auditNativeToolName(item: CodexThreadItem): string | undefined {
  if (item.type === "dynamicToolCall") {
    return undefined;
  }
  const progressName = itemName(item);
  if (progressName) {
    return progressName;
  }
  if (item.type === "collabAgentToolCall") {
    return typeof item.tool === "string" && item.tool.trim()
      ? `collab.${item.tool.trim()}`
      : "collab_agent";
  }
  return itemMetadata.get(item.type)?.auditName;
}

export function isSideEffectingNativeToolItem(item: CodexThreadItem): boolean {
  return (
    itemStatus(item) !== "blocked" &&
    (isMutatingNativeToolItem(item) || item.type === "mcpToolCall")
  );
}

export function isProjectedNativeToolItem(item: CodexThreadItem): boolean {
  return itemMetadata.get(item.type)?.projectedTool === true;
}

export function isMutatingNativeToolItem(item: CodexThreadItem): boolean {
  if (item.type === "commandExecution") {
    // Codex commandActions describe presentation, not safety. Upstream may
    // classify mutating commands as read/search, so native commands fail closed.
    return true;
  }
  return (
    item.type === "fileChange" ||
    item.type === "collabAgentToolCall" ||
    item.type === "imageGeneration"
  );
}

export function shouldClearTerminalPresentationForNativeItem(item: CodexThreadItem): boolean {
  const metadata = itemMetadata.get(item.type);
  return metadata?.projectedTool === true || metadata?.clearsTerminal === true;
}

export function shouldAdvancePersistableAssistantBarrier(item: CodexThreadItem): boolean {
  // Sleep ends the answer segment without mutating terminal presentation.
  return (
    shouldClearTerminalPresentationForNativeItem(item) ||
    item.type === "dynamicToolCall" ||
    item.type === "sleep"
  );
}
