import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { findMatrixAccountConfig, resolveMatrixBaseConfig } from "./account-config.js";
import {
  getMatrixThreadBindingManager,
  listBindingsForAccount,
  removeBindingRecord,
  resolveBindingKey,
  setBindingRecord,
  toSessionBindingRecord,
} from "./thread-bindings-shared.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

export function registerMatrixSubagentHooks(api: OpenClawPluginApi) {
  const resolveThreadBindingFlags = (accountId?: string) => {
    const matrix = resolveMatrixBaseConfig(api.config);
    const baseThreadBindings = matrix.threadBindings;
    const accountThreadBindings = accountId
      ? findMatrixAccountConfig(api.config, accountId)?.threadBindings
      : undefined;
    return {
      enabled:
        accountThreadBindings?.enabled ??
        baseThreadBindings?.enabled ??
        api.config.session?.threadBindings?.enabled ??
        true,
      spawnSubagentSessions:
        accountThreadBindings?.spawnSubagentSessions ??
        baseThreadBindings?.spawnSubagentSessions ??
        false,
    };
  };

  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = event.requester?.channel?.trim().toLowerCase();
    if (channel !== "matrix") {
      return;
    }
    const accountId = event.requester?.accountId?.trim() || undefined;
    const threadBindingFlags = resolveThreadBindingFlags(accountId);
    if (!threadBindingFlags.enabled) {
      return {
        status: "error" as const,
        error:
          "Matrix thread bindings are disabled (set channels.matrix.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
      };
    }
    if (!threadBindingFlags.spawnSubagentSessions) {
      return {
        status: "error" as const,
        error:
          "Matrix thread-bound subagent spawns are disabled for this account (set channels.matrix.threadBindings.spawnSubagentSessions=true to enable).",
      };
    }
    try {
      const resolvedAccountId = accountId || "default";
      const manager = getMatrixThreadBindingManager(resolvedAccountId);
      if (!manager) {
        return {
          status: "error" as const,
          error:
            "Unable to create or bind a Matrix room for this subagent session. No thread binding manager available for this account.",
        };
      }

      // Resolve the room/thread target from the requester origin.
      const to = event.requester?.to?.trim() || "";
      const threadId =
        event.requester?.threadId != null ? String(event.requester.threadId).trim() : "";
      // Use the thread if available, otherwise fall back to the room target.
      const conversationId = threadId || to.replace(/^room:/, "");
      const parentConversationId = threadId ? to.replace(/^room:/, "") : undefined;

      if (!conversationId) {
        return {
          status: "error" as const,
          error:
            "Unable to create or bind a Matrix room for this subagent session. No target conversation could be resolved.",
        };
      }

      const now = Date.now();
      const record = {
        accountId: resolvedAccountId,
        conversationId,
        ...(parentConversationId ? { parentConversationId } : {}),
        targetKind: "subagent" as const,
        targetSessionKey: event.childSessionKey,
        agentId: event.agentId || undefined,
        label: event.label || undefined,
        boundBy: "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs: manager.getIdleTimeoutMs(),
        maxAgeMs: manager.getMaxAgeMs(),
      };
      setBindingRecord(record);
      return { status: "ok" as const, threadBindingReady: true };
    } catch (err) {
      return {
        status: "error" as const,
        error: `Matrix thread bind failed: ${summarizeError(err)}`,
      };
    }
  });

  api.on("subagent_ended", (event) => {
    const accountId = event.accountId?.trim() || undefined;
    // Find and remove all bindings matching the ended subagent session.
    const allAccountIds = accountId
      ? [accountId]
      : [...new Set(listBindingsForAccount("default").map((b) => b.accountId))];
    for (const acctId of allAccountIds) {
      const bindings = listBindingsForAccount(acctId).filter(
        (entry) =>
          entry.targetSessionKey === event.targetSessionKey && entry.targetKind === "subagent",
      );
      for (const binding of bindings) {
        removeBindingRecord(binding);
      }
    }
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "matrix") {
      return;
    }
    const requesterAccountId = event.requesterOrigin?.accountId?.trim();
    const requesterThreadId =
      event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
        ? String(event.requesterOrigin.threadId).trim()
        : "";

    // Collect bindings across all accounts if no specific account is given.
    const accountId = requesterAccountId || "default";
    const bindings = listBindingsForAccount(accountId).filter(
      (entry) =>
        entry.targetSessionKey === event.childSessionKey && entry.targetKind === "subagent",
    );
    if (bindings.length === 0) {
      return;
    }

    let binding: (typeof bindings)[number] | undefined;
    if (requesterThreadId) {
      binding = bindings.find((entry) => {
        if (entry.conversationId !== requesterThreadId) {
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

    // Build the delivery target from the binding.
    const roomId = binding.parentConversationId ?? binding.conversationId;
    const threadId =
      binding.parentConversationId && binding.parentConversationId !== binding.conversationId
        ? binding.conversationId
        : undefined;
    return {
      origin: {
        channel: "matrix",
        accountId: binding.accountId,
        to: `room:${roomId}`,
        ...(threadId ? { threadId } : {}),
      },
    };
  });
}
