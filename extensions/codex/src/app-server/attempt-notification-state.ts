import { readCodexNotificationItem } from "./attempt-notifications.js";
import { itemName } from "./event-projector-items.js";
import type { CodexServerNotification } from "./protocol.js";

type CodexExecutionPhase =
  | { phase: "turn_accepted" }
  | { phase: "assistant_output_started" }
  | { phase: "tool_execution_started"; itemId?: string; tool: string };

/** Emits coarse execution phases exactly once from app-server notifications. */
export function reportCodexExecutionNotification(params: {
  notification: CodexServerNotification;
  emitExecutionPhaseOnce: (key: string, info: CodexExecutionPhase) => void;
}): void {
  const { notification } = params;
  if (notification.method === "turn/started") {
    params.emitExecutionPhaseOnce("turn_accepted", { phase: "turn_accepted" });
    return;
  }
  if (notification.method === "item/agentMessage/delta") {
    params.emitExecutionPhaseOnce("assistant_output_started", {
      phase: "assistant_output_started",
    });
    return;
  }
  if (notification.method !== "item/started") {
    return;
  }
  const item = readCodexNotificationItem(notification.params);
  const tool = item ? itemName(item) : undefined;
  if (!item || !tool) {
    return;
  }
  params.emitExecutionPhaseOnce(`tool:${item.id}`, {
    phase: "tool_execution_started",
    tool,
    itemId: item.id,
  });
}
