import { readItemString } from "./event-projector-values.js";
import type { CodexThreadItem } from "./protocol.js";

export type CodexNativeToolAuditStatus = ReturnType<typeof itemStatus> | "cancelled" | "unknown";
export type CodexNativeToolUnfinishedStatus = Extract<
  CodexNativeToolAuditStatus,
  "failed" | "unknown"
>;

type CodexItemPresentation = {
  kind: "tool" | "command" | "patch" | "search" | "analysis";
  title: string;
  toolName?: string;
  projectedTool?: true;
};

const itemPresentations = new Map<string, CodexItemPresentation>([
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
]);

export function matchesCodexSnapshotTurn(item: CodexThreadItem, turnId: string): boolean {
  // Missing turnId inherits the validated enclosing snapshot; explicit foreign IDs do not.
  const itemTurnId = readItemString(item, "turnId");
  return itemTurnId === undefined || itemTurnId === turnId;
}

export function itemKind(item: CodexThreadItem): CodexItemPresentation["kind"] | undefined {
  return itemPresentations.get(item.type)?.kind;
}

export function itemTitle(item: CodexThreadItem): string {
  return itemPresentations.get(item.type)?.title ?? item.type;
}

export function itemStatus(item: CodexThreadItem): "completed" | "failed" | "running" | "blocked" {
  const status = readItemString(item, "status");
  if (status === "failed" || status === "error") {
    return "failed";
  }
  if (status === "declined") {
    return "blocked";
  }
  if (status === "inProgress" || status === "in_progress" || status === "running") {
    return "running";
  }
  return "completed";
}

export function unknownItemStatus(item: CodexThreadItem): string | undefined {
  const status = readItemString(item, "status");
  switch (status) {
    case undefined:
    case "completed":
    case "failed":
    case "error":
    case "declined":
    case "inProgress":
    case "in_progress":
    case "running":
      return undefined;
    default:
      return status;
  }
}

export function auditNativeToolTerminalStatus(item: CodexThreadItem): CodexNativeToolAuditStatus {
  if (item.type === "imageView" || item.type === "sleep") {
    return "completed";
  }
  const status = readItemString(item, "status");
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed" || status === "error") {
    return "failed";
  }
  if (status === "declined") {
    return "blocked";
  }
  // A completed notification with a missing, active, or new status does not
  // prove success. Preserve that ambiguity at the durable audit boundary.
  return "unknown";
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
  return itemPresentations.get(item.type)?.toolName;
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
  if (item.type === "imageGeneration") {
    return "image_generation";
  }
  if (item.type === "imageView") {
    return "image_view";
  }
  if (item.type === "sleep") {
    return "sleep";
  }
  return undefined;
}

export function isSideEffectingNativeToolItem(item: CodexThreadItem): boolean {
  return (
    itemStatus(item) !== "blocked" &&
    (isMutatingNativeToolItem(item) || item.type === "mcpToolCall")
  );
}

export function isProjectedNativeToolItem(item: CodexThreadItem): boolean {
  return itemPresentations.get(item.type)?.projectedTool === true;
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
  switch (item.type) {
    case "collabAgentToolCall":
    case "commandExecution":
    case "fileChange":
    case "imageGeneration":
    case "imageView":
    case "mcpToolCall":
    case "webSearch":
      return true;
    default:
      return false;
  }
}
