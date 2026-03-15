import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuTarget } from "./targets.js";
import { getFeishuThreadBindingManager } from "./thread-bindings.js";

export function registerFeishuSubagentHooks(api: OpenClawPluginApi) {
  const resolveThreadBindingFlags = (accountId?: string) => {
    const account = resolveFeishuAccount({
      cfg: api.config,
      accountId,
    });
    const baseThreadBindings = (api.config.channels?.feishu as Record<string, unknown> | undefined)
      ?.threadBindings as Record<string, unknown> | undefined;
    const accountConfig = (api.config.channels?.feishu as Record<string, unknown> | undefined)
      ?.accounts as Record<string, Record<string, unknown> | undefined> | undefined;
    const accountThreadBindings = accountConfig?.[account.accountId]?.threadBindings as
      | Record<string, unknown>
      | undefined;
    return {
      enabled:
        (accountThreadBindings?.enabled as boolean | undefined) ??
        (baseThreadBindings?.enabled as boolean | undefined) ??
        (api.config.session?.threadBindings?.enabled as boolean | undefined) ??
        true,
      spawnSubagentSessions:
        (accountThreadBindings?.spawnSubagentSessions as boolean | undefined) ??
        (baseThreadBindings?.spawnSubagentSessions as boolean | undefined) ??
        true,
    };
  };

  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "feishu") {
      return;
    }
    const threadBindingFlags = resolveThreadBindingFlags(event.requester?.accountId);
    if (!threadBindingFlags.enabled) {
      return {
        status: "error" as const,
        error:
          "Feishu thread bindings are disabled (set channels.feishu.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
      };
    }
    if (!threadBindingFlags.spawnSubagentSessions) {
      return {
        status: "error" as const,
        error:
          "Feishu thread-bound subagent spawns are disabled for this account (set channels.feishu.threadBindings.spawnSubagentSessions=true to enable).",
      };
    }
    // Feishu doesn't automatically create topic threads for subagent sessions
    // like Discord does, so we only support "current" placement via /focus.
    return;
  });

  api.on("subagent_ended", (event) => {
    const manager = getFeishuThreadBindingManager(event.accountId);
    if (!manager) {
      return;
    }
    manager.unbindBySessionKey({
      targetSessionKey: event.targetSessionKey,
      reason: event.reason,
      sendFarewell: false,
    });
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "feishu") {
      return;
    }
    const requesterAccountId = event.requesterOrigin?.accountId?.trim();
    const manager = getFeishuThreadBindingManager(requesterAccountId);
    if (!manager) {
      return;
    }
    const bindings = manager.listBySessionKey(event.childSessionKey);
    if (bindings.length === 0) {
      return;
    }

    // Match by requester conversation to avoid routing to the wrong chat
    // when the same subagent is focused in multiple conversations.
    // Normalize requester target: requesterOrigin.to may carry transport
    // prefixes (e.g. "user:ou_...") while bindings store raw IDs ("ou_...").
    const rawRequesterTo = event.requesterOrigin?.to?.trim() || "";
    const requesterTo = normalizeFeishuTarget(rawRequesterTo) || rawRequesterTo;
    const requesterThreadId =
      event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
        ? String(event.requesterOrigin.threadId).trim()
        : "";
    let binding: (typeof bindings)[number] | undefined;
    if (requesterTo || requesterThreadId) {
      binding = bindings.find((entry) => {
        if (requesterThreadId && entry.conversationId.endsWith(`:topic:${requesterThreadId}`)) {
          return true;
        }
        if (requesterTo && entry.conversationId === requesterTo) {
          return true;
        }
        return false;
      });
    }
    if (!binding && bindings.length === 1) {
      binding = bindings[0];
    }
    if (!binding) {
      return;
    }

    // Split topic-style conversation IDs (chatId:topic:threadId) into
    // separate to/threadId fields for outbound Feishu delivery.
    const topicMatch = binding.conversationId.match(/^(.+):topic:(.+)$/);
    if (topicMatch) {
      return {
        origin: {
          channel: "feishu",
          accountId: binding.accountId,
          to: topicMatch[1],
          threadId: topicMatch[2],
        },
      };
    }
    return {
      origin: {
        channel: "feishu",
        accountId: binding.accountId,
        to: binding.conversationId,
      },
    };
  });
}
