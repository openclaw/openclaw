import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingSpawnPolicy,
  resolveThreadBindingThreadName,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { parseTelegramTarget } from "./targets.js";
import { parseTelegramTopicConversation } from "./topic-conversation.js";

type TelegramSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId: string;
  label?: string;
};

type TelegramSubagentEndedEvent = {
  targetSessionKey: string;
  targetKind?: string;
  accountId?: string;
  reason?: string;
};

type TelegramSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
};

type TelegramDeliveryOrigin = {
  channel: "telegram";
  accountId: string;
  to: string;
  threadId: string;
};

type TelegramSubagentSpawningResult =
  | {
      status: "ok";
      threadBindingReady?: boolean;
      deliveryOrigin?: TelegramDeliveryOrigin;
    }
  | { status: "error"; error: string }
  | undefined;

type TelegramSubagentDeliveryTargetResult =
  | {
      origin: TelegramDeliveryOrigin;
    }
  | undefined;

const TELEGRAM_FORUM_TOPIC_REQUIRED_ERROR =
  "Telegram thread-bound subagent sessions require a group or supergroup chat target that can host forum topics.";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function resolveRequesterForumChatId(requester?: {
  to?: string;
}): { chatId: string } | { error: string } {
  const rawTo = normalizeOptionalString(requester?.to);
  if (!rawTo) {
    return {
      error:
        "Cannot create Telegram thread binding: no chat target in spawn request (requester.to must be a Telegram group or supergroup chat ID).",
    };
  }
  const target = parseTelegramTarget(rawTo);
  const chatId = normalizeOptionalString(target.chatId) ?? "";
  if (target.chatType !== "group" || !chatId.startsWith("-")) {
    return { error: TELEGRAM_FORUM_TOPIC_REQUIRED_ERROR };
  }
  return { chatId };
}

function resolveTelegramBindingDeliveryOrigin(
  binding: SessionBindingRecord,
  fallbackAccountId: string,
): TelegramDeliveryOrigin | null {
  const parsed = parseTelegramTopicConversation({
    conversationId: binding.conversation.conversationId,
    parentConversationId: binding.conversation.parentConversationId,
  });
  if (!parsed) {
    return null;
  }
  return {
    channel: "telegram",
    accountId: normalizeOptionalString(binding.conversation.accountId) || fallbackAccountId,
    to: parsed.chatId,
    threadId: parsed.topicId,
  };
}

function isTelegramSubagentBinding(binding: SessionBindingRecord): boolean {
  return binding.conversation.channel === "telegram" && binding.targetKind === "subagent";
}

export async function handleTelegramSubagentSpawning(
  api: OpenClawPluginApi,
  event: TelegramSubagentSpawningEvent,
): Promise<TelegramSubagentSpawningResult> {
  if (!event.threadRequested) {
    return undefined;
  }
  const channel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (channel !== "telegram") {
    return undefined;
  }

  const account = resolveTelegramAccount({
    cfg: api.config,
    accountId: event.requester?.accountId,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: api.config,
    channel: "telegram",
    accountId: account.accountId,
    kind: "subagent",
  });
  if (!policy.enabled) {
    return {
      status: "error",
      error: formatThreadBindingDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "subagent",
      }),
    };
  }
  if (!policy.spawnEnabled) {
    return {
      status: "error",
      error: formatThreadBindingSpawnDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "subagent",
      }),
    };
  }

  const forumTarget = resolveRequesterForumChatId(event.requester);
  if ("error" in forumTarget) {
    return { status: "error", error: forumTarget.error };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: "telegram",
    accountId: account.accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return {
      status: "error",
      error: `No Telegram session binding adapter available for account "${account.accountId}". Is the Telegram channel running?`,
    };
  }
  if (!capabilities.placements.includes("child")) {
    return {
      status: "error",
      error: `Telegram session binding adapter for account "${account.accountId}" does not support child forum topic bindings.`,
    };
  }

  try {
    const binding = await bindingService.bind({
      targetSessionKey: event.childSessionKey,
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: account.accountId,
        conversationId: forumTarget.chatId,
      },
      placement: "child",
      metadata: {
        agentId: normalizeOptionalString(event.agentId) || undefined,
        label: normalizeOptionalString(event.label) || undefined,
        threadName: resolveThreadBindingThreadName({
          agentId: event.agentId,
          label: event.label,
        }),
        boundBy: "system",
      },
    });
    const deliveryOrigin = resolveTelegramBindingDeliveryOrigin(binding, account.accountId);
    if (!deliveryOrigin) {
      return {
        status: "error",
        error: "Telegram thread bind failed: adapter returned a non-topic binding.",
      };
    }
    return {
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin,
    };
  } catch (err) {
    return {
      status: "error",
      error: `Telegram thread bind failed: ${summarizeError(err)}`,
    };
  }
}

export async function handleTelegramSubagentEnded(
  event: TelegramSubagentEndedEvent,
): Promise<void> {
  if (normalizeOptionalLowercaseString(event.targetKind) !== "subagent") {
    return;
  }
  const requesterAccountId = normalizeOptionalString(event.accountId);
  const bindingService = getSessionBindingService();
  const bindings = bindingService
    .listBySession(event.targetSessionKey)
    .filter(
      (entry) =>
        isTelegramSubagentBinding(entry) &&
        (!requesterAccountId || entry.conversation.accountId === requesterAccountId),
    );
  const reason = normalizeOptionalString(event.reason) || "subagent-ended";
  for (const binding of bindings) {
    await bindingService.unbind({ bindingId: binding.bindingId, reason });
  }
}

export function handleTelegramSubagentDeliveryTarget(
  event: TelegramSubagentDeliveryTargetEvent,
): TelegramSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "telegram") {
    return undefined;
  }

  const requesterAccountId = normalizeOptionalString(event.requesterOrigin?.accountId);
  const requesterThreadId = normalizeOptionalStringifiedId(event.requesterOrigin?.threadId);
  const requesterTo = normalizeOptionalString(event.requesterOrigin?.to);
  const requesterChatId = requesterTo ? parseTelegramTarget(requesterTo).chatId.trim() : "";
  const bindings = getSessionBindingService()
    .listBySession(event.childSessionKey)
    .filter(
      (entry) =>
        isTelegramSubagentBinding(entry) &&
        (!requesterAccountId || entry.conversation.accountId === requesterAccountId),
    );
  if (bindings.length === 0) {
    return undefined;
  }

  let binding: SessionBindingRecord | undefined;
  if (requesterThreadId || requesterChatId) {
    binding = bindings.find((entry) => {
      const origin = resolveTelegramBindingDeliveryOrigin(
        entry,
        requesterAccountId || entry.conversation.accountId,
      );
      if (!origin) {
        return false;
      }
      if (requesterThreadId && origin.threadId !== requesterThreadId) {
        return false;
      }
      if (requesterChatId && origin.to !== requesterChatId) {
        return false;
      }
      return true;
    });
  }
  if (!binding && bindings.length === 1) {
    binding = bindings[0];
  }
  if (!binding) {
    return undefined;
  }

  const origin = resolveTelegramBindingDeliveryOrigin(
    binding,
    requesterAccountId || binding.conversation.accountId,
  );
  return origin ? { origin } : undefined;
}
