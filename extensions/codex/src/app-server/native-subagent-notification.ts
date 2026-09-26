import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

export const NATIVE_SUBAGENT_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/closed",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/started",
  "item/completed",
  // App-server exposes no typed terminal subagent result. Keep this one raw
  // boundary until its protocol provides the child's terminal status and text.
  "rawResponseItem/completed",
]);
export const RECOVERY_REVISION_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
]);

const CODEX_SUBAGENT_NOTIFICATION_START = "<subagent_notification>";
const CODEX_SUBAGENT_NOTIFICATION_END = "</subagent_notification>";

type CodexNativeSubagentCompletionDetails = {
  status: "succeeded" | "failed" | "cancelled";
  statusLabel: string;
  result: string;
};

export type CodexNativeSubagentCompletion = CodexNativeSubagentCompletionDetails & {
  childThreadId: string;
};

/** Completion parsed from a notification payload before agent-path matching resolves the thread. */
type CodexNativeSubagentNotificationCompletion = CodexNativeSubagentCompletionDetails & {
  agentPath: string;
};

function extractCodexNativeSubagentCompletions(
  notification: CodexServerNotification,
): CodexNativeSubagentNotificationCompletion[] {
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  if (!params) {
    return [];
  }
  const item = isJsonObject(params.item) ? params.item : undefined;
  if (!item) {
    return [];
  }
  if (notification.method === "rawResponseItem/completed" && item.role === "user") {
    return readTrustedContextualCompletions(item);
  }
  return [];
}

function readTrustedContextualCompletions(
  item: JsonObject,
): CodexNativeSubagentNotificationCompletion[] {
  const content = item.content;
  const metadata = item.internal_chat_message_metadata_passthrough;
  const kinds = isJsonObject(metadata) ? metadata.content_item_kinds : undefined;
  if (
    item.type !== "message" ||
    !Array.isArray(content) ||
    !Array.isArray(kinds) ||
    content.length !== kinds.length
  ) {
    return [];
  }
  // Codex classifies each contextual fragment separately. Adjacent user text
  // cannot borrow the native fragment's classification or forge its receipt.
  return content.flatMap((entry, index) => {
    if (
      kinds[index] !== "multi_agent.subagent_notification" ||
      !isJsonObject(entry) ||
      entry.type !== "input_text"
    ) {
      return [];
    }
    const text = readString(entry, "text")?.trim();
    if (
      !text?.startsWith(CODEX_SUBAGENT_NOTIFICATION_START) ||
      !text.endsWith(CODEX_SUBAGENT_NOTIFICATION_END)
    ) {
      return [];
    }
    const completion = parseCodexNativeSubagentNotificationBody(
      text.slice(CODEX_SUBAGENT_NOTIFICATION_START.length, -CODEX_SUBAGENT_NOTIFICATION_END.length),
    );
    return completion ? [completion] : [];
  });
}

export const codexNativeSubagentNotifications = {
  fromNotification: extractCodexNativeSubagentCompletions,
  deliveredAgentPaths: readDeliveredNativeCompletionPaths,
};

/** Reads native delivery receipts, leaving status and result ownership with the child lifecycle. */
function readDeliveredNativeCompletionPaths(notification: CodexServerNotification): string[] {
  const params = isJsonObject(notification.params) ? notification.params : undefined;
  const item = isJsonObject(params?.item) ? params.item : undefined;
  // V1 wait returns these exact terminal states to the foreground parent.
  // The wait tool finishing alone says nothing about a still-running child.
  if (
    notification.method === "item/completed" &&
    item?.type === "collabAgentToolCall" &&
    item.tool === "wait" &&
    (item.status === "completed" || item.status === "failed") &&
    item.senderThreadId === params?.threadId &&
    Array.isArray(item.receiverThreadIds) &&
    isJsonObject(item.agentsStates)
  ) {
    const receivers = new Set(item.receiverThreadIds);
    return Object.entries(item.agentsStates).flatMap(([threadId, state]) =>
      receivers.has(threadId) &&
      isJsonObject(state) &&
      ["completed", "errored", "shutdown", "notFound"].includes(readString(state, "status") ?? "")
        ? [threadId]
        : [],
    );
  }
  if (notification.method !== "rawResponseItem/completed") {
    return [];
  }
  if (!item || readString(item, "type") !== "agent_message") {
    return extractCodexNativeSubagentCompletions(notification).map(
      (completion) => completion.agentPath,
    );
  }
  const author = readString(item, "author");
  const recipient = readString(item, "recipient");
  const content = item.content;
  if (!author || !recipient || !Array.isArray(content) || content.length !== 1) {
    return [];
  }
  const part = content[0];
  if (!isJsonObject(part) || readString(part, "type") !== "input_text") {
    return [];
  }
  const text = readString(part, "text");
  // Codex's native completion envelope identifies both endpoints outside the
  // payload. Ordinary messages and quoted completion text are not receipts.
  return text?.startsWith(
    `Message Type: FINAL_ANSWER\nTask name: ${recipient}\nSender: ${author}\nPayload:\n`,
  )
    ? [author]
    : [];
}

function parseCodexNativeSubagentNotificationBody(
  body: string,
): CodexNativeSubagentNotificationCompletion | undefined {
  let payload: JsonValue;
  try {
    payload = JSON.parse(body.trim());
  } catch {
    return undefined;
  }
  if (!isJsonObject(payload)) {
    return undefined;
  }
  const agentPath = readString(payload, "agent_path")?.trim();
  const completion = readCompletionStatus(payload.status);
  return agentPath && completion ? { agentPath, ...completion } : undefined;
}

function readCompletionStatus(
  status: JsonValue | undefined,
): CodexNativeSubagentCompletionDetails | undefined {
  if (status === "shutdown" || status === "not_found") {
    return {
      status: status === "shutdown" ? "cancelled" : "failed",
      statusLabel: status,
      result: "(no output)",
    };
  }
  if (!isJsonObject(status)) {
    return undefined;
  }
  const completed = status.completed;
  if (completed === null || typeof completed === "string") {
    const result = completed?.trim();
    return {
      status: "succeeded",
      statusLabel: result ? "completed" : "completed_without_final_message",
      result: result || "Subagent completed without a final assistant message.",
    };
  }
  const error = readString(status, "errored");
  return error === undefined
    ? undefined
    : { status: "failed", statusLabel: "errored", result: error.trim() || "(no output)" };
}
