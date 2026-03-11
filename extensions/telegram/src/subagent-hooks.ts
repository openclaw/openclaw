import type { OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";
import { resolveTelegramAccount } from "openclaw/plugin-sdk/telegram";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingSpawnPolicy,
} from "../../../src/channels/thread-bindings-policy.js";
import { getSessionBindingService } from "../../../src/infra/outbound/session-binding-service.js";
import { ensureTelegramThreadBindingManager } from "../../../src/telegram/thread-bindings.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function normalizeString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return `${value}`.trim();
  }
  return "";
}

function resolveTelegramThreadBindingFlags(api: OpenClawPluginApi, accountId?: string) {
  const account = resolveTelegramAccount({
    cfg: api.config,
    accountId,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: api.config,
    channel: "telegram",
    accountId: account.accountId,
    kind: "subagent",
  });
  return {
    accountId: policy.accountId,
    enabled: policy.enabled,
    spawnSubagentSessions: policy.spawnEnabled,
  };
}

function resolveTelegramConversationId(params: {
  to?: string;
  threadId?: string | number;
}): string | null {
  const rawTo = normalizeString(params.to);
  const rawThreadId = normalizeString(params.threadId);
  const target = rawTo.startsWith("channel:")
    ? rawTo.slice(8)
    : rawTo.startsWith("telegram:")
      ? rawTo.slice(9)
      : rawTo;
  if (!target) {
    return null;
  }
  if (target.includes(":topic:")) {
    return target;
  }
  if (rawThreadId) {
    return `${target}:topic:${rawThreadId}`;
  }
  if (target.startsWith("-")) {
    return null;
  }
  return target;
}

function buildTelegramDeliveryOrigin(params: { accountId: string; conversationId: string }) {
  const topicMarker = ":topic:";
  const topicIndex = params.conversationId.indexOf(topicMarker);
  if (topicIndex >= 0) {
    const chatId = params.conversationId.slice(0, topicIndex).trim();
    const threadId = params.conversationId.slice(topicIndex + topicMarker.length).trim();
    if (!chatId || !threadId) {
      return null;
    }
    return {
      channel: "telegram" as const,
      accountId: params.accountId,
      to: `channel:${chatId}`,
      threadId,
    };
  }

  if (!params.conversationId.trim()) {
    return null;
  }
  return {
    channel: "telegram" as const,
    accountId: params.accountId,
    to: `channel:${params.conversationId}`,
  };
}

export function registerTelegramSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", async (event) => {
    if (!event.threadRequested) {
      return;
    }
    const channel = normalizeString(event.requester?.channel).toLowerCase();
    if (channel !== "telegram") {
      return;
    }

    const threadBindingFlags = resolveTelegramThreadBindingFlags(api, event.requester?.accountId);
    if (!threadBindingFlags.enabled) {
      return {
        status: "error" as const,
        error: formatThreadBindingDisabledError({
          channel: "telegram",
          accountId: threadBindingFlags.accountId,
          kind: "subagent",
        }),
      };
    }
    if (!threadBindingFlags.spawnSubagentSessions) {
      return {
        status: "error" as const,
        error: formatThreadBindingSpawnDisabledError({
          channel: "telegram",
          accountId: threadBindingFlags.accountId,
          kind: "subagent",
        }),
      };
    }

    const conversationId = resolveTelegramConversationId({
      to: event.requester?.to,
      threadId: event.requester?.threadId,
    });
    if (!conversationId) {
      return {
        status: "error" as const,
        error: "Could not resolve a telegram conversation for this subagent session.",
      };
    }

    ensureTelegramThreadBindingManager({
      cfg: api.config,
      accountId: threadBindingFlags.accountId,
    });
    const bindingService = getSessionBindingService();
    const capabilities = bindingService.getCapabilities({
      channel: "telegram",
      accountId: threadBindingFlags.accountId,
    });
    if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
      return {
        status: "error" as const,
        error: "Thread bindings are unavailable for telegram.",
      };
    }
    if (!capabilities.placements.includes("current")) {
      return {
        status: "error" as const,
        error: "Thread bindings do not support current placement for telegram.",
      };
    }

    try {
      await bindingService.bind({
        targetSessionKey: event.childSessionKey,
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: threadBindingFlags.accountId,
          conversationId,
        },
        placement: "current",
        metadata: {
          agentId: event.agentId,
          label: event.label || undefined,
          boundBy: "system",
        },
      });
      return {
        status: "ok" as const,
        threadBindingReady: true,
      };
    } catch (err) {
      return {
        status: "error" as const,
        error: `Telegram conversation bind failed: ${summarizeError(err)}`,
      };
    }
  });

  api.on("subagent_ended", async (event) => {
    if (event.targetKind !== "subagent") {
      return;
    }
    await getSessionBindingService().unbind({
      targetSessionKey: event.targetSessionKey,
      reason: event.reason,
    });
  });

  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = normalizeString(event.requesterOrigin?.channel).toLowerCase();
    if (requesterChannel !== "telegram") {
      return;
    }

    const requesterAccountId = normalizeString(event.requesterOrigin?.accountId);
    const requesterConversationId = resolveTelegramConversationId({
      to: event.requesterOrigin?.to,
      threadId: event.requesterOrigin?.threadId,
    });

    const bindings = getSessionBindingService()
      .listBySession(event.childSessionKey)
      .filter(
        (binding) => binding.status === "active" && binding.conversation.channel === "telegram",
      );
    if (bindings.length === 0) {
      return;
    }

    let binding = bindings.find((entry) => {
      if (
        requesterAccountId &&
        normalizeString(entry.conversation.accountId) !== requesterAccountId
      ) {
        return false;
      }
      if (
        requesterConversationId &&
        normalizeString(entry.conversation.conversationId) !== requesterConversationId
      ) {
        return false;
      }
      return true;
    });
    if (!binding && bindings.length === 1) {
      binding = bindings[0];
    }
    if (!binding) {
      return;
    }

    const origin = buildTelegramDeliveryOrigin({
      accountId: binding.conversation.accountId,
      conversationId: binding.conversation.conversationId,
    });
    if (!origin) {
      return;
    }
    return { origin };
  });
}
