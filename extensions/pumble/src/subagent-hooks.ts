import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolvePumbleThreadBindingsConfig } from "./pumble/config-accessors.js";
import {
  autoBindSpawnedPumbleSubagent,
  listPumbleThreadBindingsBySessionKey,
  unbindPumbleThreadBindingsBySessionKey,
} from "./pumble/thread-bindings.lifecycle.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

export function registerPumbleSubagentHooks(api: OpenClawPluginApi) {
  const resolveThreadBindingFlags = (accountId?: string) => {
    return resolvePumbleThreadBindingsConfig(api.config, accountId);
  };

  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "pumble") {
      return;
    }
    const threadBindingFlags = resolveThreadBindingFlags(event.requester?.accountId);
    if (!threadBindingFlags.enabled) {
      return {
        status: "error" as const,
        error:
          "Pumble thread bindings are disabled (set channels.pumble.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
      };
    }
    if (!threadBindingFlags.spawnSubagentSessions) {
      return {
        status: "error" as const,
        error:
          "Pumble thread-bound subagent spawns are disabled for this account (set channels.pumble.threadBindings.spawnSubagentSessions=true to enable).",
      };
    }
    try {
      const binding = await autoBindSpawnedPumbleSubagent({
        accountId: event.requester?.accountId,
        to: event.requester?.to,
        threadId: event.requester?.threadId != null ? String(event.requester.threadId) : undefined,
        childSessionKey: event.childSessionKey,
        agentId: event.agentId,
        label: event.label,
        boundBy: "system",
      });
      if (!binding) {
        return {
          status: "error" as const,
          error:
            "Unable to create or bind a Pumble thread for this subagent session. Session mode is unavailable for this target.",
        };
      }
      return { status: "ok" as const, threadBindingReady: true };
    } catch (err) {
      return {
        status: "error" as const,
        error: `Pumble thread bind failed: ${summarizeError(err)}`,
      };
    }
  });

  api.on("subagent_ended", (event) => {
    unbindPumbleThreadBindingsBySessionKey({
      targetSessionKey: event.targetSessionKey,
      accountId: event.accountId,
      reason: event.reason,
      sendFarewell: false,
    });
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "pumble") {
      return;
    }
    const requesterAccountId = event.requesterOrigin?.accountId?.trim();
    const requesterThreadId =
      event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
        ? String(event.requesterOrigin.threadId).trim()
        : "";
    const bindings = listPumbleThreadBindingsBySessionKey({
      targetSessionKey: event.childSessionKey,
      ...(requesterAccountId ? { accountId: requesterAccountId } : {}),
    });
    if (bindings.length === 0) {
      return;
    }

    let binding: (typeof bindings)[number] | undefined;
    if (requesterThreadId) {
      binding = bindings.find((entry) => {
        if (entry.threadRootId !== requesterThreadId) {
          return false;
        }
        if (requesterAccountId && entry.accountId !== requesterAccountId) {
          return false;
        }
        return true;
      });
    }
    if (!binding && bindings.length === 1) {
      binding = bindings[0];
    }
    if (!binding) {
      return;
    }
    return {
      origin: {
        channel: "pumble",
        accountId: binding.accountId,
        to: `channel:${binding.channelId}`,
        threadId: binding.threadRootId,
      },
    };
  });
}
