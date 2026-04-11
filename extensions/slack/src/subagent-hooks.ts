import type {
  PluginHookSubagentDeliveryTargetEvent,
  PluginHookSubagentDeliveryTargetResult,
} from "openclaw/plugin-sdk/plugin-types";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-api-types";

/**
 * Route subagent completion messages back into the originating Slack thread.
 *
 * When a subagent is spawned from within a Slack thread, the requester origin
 * already carries the correct `threadId` (Slack thread_ts). This hook reads
 * it back so the completion message is delivered into the same thread instead
 * of the main channel.
 */
export function handleSlackSubagentDeliveryTarget(
  event: PluginHookSubagentDeliveryTargetEvent,
): PluginHookSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }

  const requesterChannel = event.requesterOrigin?.channel?.toLowerCase()?.trim();
  if (requesterChannel !== "slack") {
    return undefined;
  }

  const threadId = event.requesterOrigin?.threadId;
  if (threadId == null || String(threadId).trim() === "") {
    return undefined;
  }

  const accountId = event.requesterOrigin?.accountId?.trim() || undefined;
  const to = event.requesterOrigin?.to?.trim() || undefined;

  return {
    origin: {
      channel: "slack" as const,
      ...(accountId ? { accountId } : {}),
      ...(to ? { to } : {}),
      threadId,
    },
  };
}

export function registerSlackSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_delivery_target", (event) =>
    handleSlackSubagentDeliveryTarget(event),
  );
}
