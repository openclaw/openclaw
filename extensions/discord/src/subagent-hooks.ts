import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  autoBindSpawnedDiscordSubagent,
  unbindThreadBindingsBySessionKey,
} from "openclaw/plugin-sdk";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

export function registerDiscordSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "discord") {
      const channelLabel = event.requester?.channel?.trim() || "unknown";
      return {
        status: "error" as const,
        error: `thread=true is not supported for channel "${channelLabel}". Only Discord thread-bound subagent sessions are supported right now.`,
      };
    }
    try {
      const binding = await autoBindSpawnedDiscordSubagent({
        accountId: event.requester?.accountId,
        channel: event.requester?.channel,
        to: event.requester?.to,
        threadId: event.requester?.threadId,
        childSessionKey: event.childSessionKey,
        agentId: event.agentId,
        label: event.label,
        boundBy: "system",
      });
      if (!binding) {
        return {
          status: "error" as const,
          error:
            "Unable to create or bind a Discord thread for this subagent session. Session mode is unavailable for this target.",
        };
      }
      return { status: "ok" as const, threadBindingReady: true };
    } catch (err) {
      return {
        status: "error" as const,
        error: `Discord thread bind failed: ${summarizeError(err)}`,
      };
    }
  });

  api.on("subagent_ended", (event) => {
    unbindThreadBindingsBySessionKey({
      targetSessionKey: event.targetSessionKey,
      accountId: event.accountId,
      targetKind: event.targetKind,
      reason: event.reason,
      sendFarewell: event.sendFarewell,
    });
  });
}
