import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractRawResponseItemText } from "./event-projector-values.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type JsonValue,
} from "./protocol.js";

const CODEX_TURN_ABORT_MARKER_START = "<turn_aborted>";
const CODEX_TURN_ABORT_MARKER_END = "</turn_aborted>";

/** Tracks actual native items for explicit terminal-tool batching. */
export function updateActiveTurnItemIds(
  notification: CodexServerNotification,
  activeItemIds: Set<string>,
): void {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }
  const itemId = readNotificationItemId(notification);
  if (!itemId) {
    return;
  }
  if (notification.method === "item/started") {
    activeItemIds.add(itemId);
    return;
  }
  activeItemIds.delete(itemId);
}

function readNotificationItemId(notification: CodexServerNotification): string | undefined {
  if (!isJsonObject(notification.params)) {
    return undefined;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  return (
    (item ? readString(item, "id") : undefined) ??
    readString(notification.params, "itemId") ??
    readString(notification.params, "id")
  );
}

export function completePendingOpenClawDynamicToolNotification(
  notification: CodexServerNotification,
  pendingOpenClawDynamicToolCompletionIds: Set<string>,
): void {
  if (notification.method !== "item/completed" || !isJsonObject(notification.params)) {
    return;
  }
  const itemId = readNotificationItemId(notification);
  if (!itemId || !pendingOpenClawDynamicToolCompletionIds.has(itemId)) {
    return;
  }
  const item = isJsonObject(notification.params.item) ? notification.params.item : undefined;
  const itemType = item ? readString(item, "type") : undefined;
  if (itemType === undefined || itemType === "dynamicToolCall") {
    pendingOpenClawDynamicToolCompletionIds.delete(itemId);
  }
}

export function isRawFunctionToolOutputCompletionNotification(
  notification: CodexServerNotification,
): boolean {
  const item = readCompletedRawItem(notification);
  return item ? readString(item, "type") === "function_call_output" : false;
}

export function isTerminalTurnStatus(status: string | undefined): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

/** Detects Codex's interrupted-turn marker, not user-authored copies of it. */
export function isCodexTurnAbortMarkerNotification(
  notification: CodexServerNotification,
  options: { currentPromptText?: string } = {},
): boolean {
  const item = readCompletedRawItem(notification);
  const role = item ? readString(item, "role") : undefined;
  if (
    !item ||
    readString(item, "type") !== "message" ||
    (role !== "user" && role !== "developer")
  ) {
    return false;
  }
  const text = extractRawResponseItemText(item, "input_text") ?? "";
  if (role === "user" && options.currentPromptText?.trim() === text) {
    return false;
  }
  return (
    text.startsWith(CODEX_TURN_ABORT_MARKER_START) && text.endsWith(CODEX_TURN_ABORT_MARKER_END)
  );
}

export function readCodexNotificationItem(
  params: JsonValue | undefined,
): CodexThreadItem | undefined {
  if (!isJsonObject(params) || !isJsonObject(params.item)) {
    return undefined;
  }
  const item = params.item;
  return typeof item.id === "string" && typeof item.type === "string"
    ? (item as CodexThreadItem)
    : undefined;
}

/** Reads the stable call id from a model-emitted raw tool item. */
export function readRawResponseToolCallId(
  notification: CodexServerNotification,
): string | undefined {
  const item = readCompletedRawItem(notification);
  if (!item) {
    return undefined;
  }
  switch (readString(item, "type")) {
    case "custom_tool_call":
    case "function_call":
    case "local_shell_call":
    case "tool_search_call":
      return readString(item, "call_id");
    case "image_generation_call":
    case "web_search_call":
      return readString(item, "id");
    default:
      return undefined;
  }
}

function readCompletedRawItem(notification: CodexServerNotification) {
  if (notification.method !== "rawResponseItem/completed" || !isJsonObject(notification.params)) {
    return undefined;
  }
  return isJsonObject(notification.params.item) ? notification.params.item : undefined;
}
