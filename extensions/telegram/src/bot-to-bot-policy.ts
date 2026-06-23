export type TelegramBotToBotPolicyConfig = {
  enabled?: boolean;
  killSwitch?: boolean;
  allowUsernames?: string[];
  maxDepth?: number;
  maxHops?: number;
  rateLimit?: {
    windowMs?: number;
    maxMessages?: number;
  };
};

export type TelegramBotToBotPolicyUser = {
  id?: string | number;
  username?: string;
  is_bot?: boolean;
};

export type TelegramBotToBotPolicyMessage = {
  chat?: {
    id?: string | number;
  };
  message_id?: string | number;
};

export type TelegramBotToBotPolicyMetadata = {
  accountId?: string;
  updateId?: string | number;
  depth?: number;
  hops?: number;
};

export type TelegramBotToBotPolicyReason =
  | "human_sender"
  | "self_loop"
  | "kill_switch"
  | "disabled_bot_sender"
  | "allowlisted_bot_sender"
  | "unknown_bot_sender"
  | "max_depth_exceeded"
  | "max_hops_exceeded";

export type TelegramBotToBotPolicyDecision = {
  decision: "allow" | "drop";
  allow: boolean;
  reason: TelegramBotToBotPolicyReason;
  senderUsername?: string;
  normalizedAllowUsernames: string[];
  dedupeKey?: string;
  senderScopeKey?: string;
  rateLimitKey?: string;
  maxDepth?: number;
  maxHops?: number;
};

export function normalizeTelegramBotToBotUsername(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/^@+/u, "").toLowerCase();
  return normalized ? normalized : undefined;
}

export function resolveTelegramBotToBotPolicy(params: {
  message?: TelegramBotToBotPolicyMessage;
  from?: TelegramBotToBotPolicyUser;
  me?: TelegramBotToBotPolicyUser;
  config?: TelegramBotToBotPolicyConfig;
  metadata?: TelegramBotToBotPolicyMetadata;
}): TelegramBotToBotPolicyDecision {
  const { message, from, me, metadata } = params;
  const config = params.config ?? {};
  const senderId = from?.id == null ? undefined : String(from.id);
  const meId = me?.id == null ? undefined : String(me.id);
  const senderUsername = normalizeTelegramBotToBotUsername(from?.username);
  const meUsername = normalizeTelegramBotToBotUsername(me?.username);
  const normalizedAllowUsernames = (config.allowUsernames ?? [])
    .map((entry) => normalizeTelegramBotToBotUsername(entry))
    .filter((entry): entry is string => Boolean(entry));
  const chatId = message?.chat?.id == null ? undefined : String(message.chat.id);
  const messageId = message?.message_id == null ? undefined : String(message.message_id);
  const updateId = metadata?.updateId == null ? undefined : String(metadata.updateId);
  const accountId = metadata?.accountId ?? "default";
  const dedupeKey =
    updateId != null
      ? ["telegram", accountId, "update", updateId].join(":")
      : chatId && messageId
        ? ["telegram", accountId, "message", chatId, messageId].join(":")
        : undefined;
  const senderScopeKey =
    chatId && (senderUsername || senderId)
      ? ["telegram-bot-to-bot", accountId, chatId, senderUsername ?? senderId].join(":")
      : undefined;
  const rateLimitKey =
    chatId && (senderUsername || senderId)
      ? ["telegram-bot-to-bot", accountId, chatId, senderUsername ?? senderId].join(":")
      : undefined;
  const base = {
    senderUsername,
    normalizedAllowUsernames,
    dedupeKey,
    senderScopeKey,
    rateLimitKey,
    maxDepth: config.maxDepth,
    maxHops: config.maxHops,
  };

  if (
    (senderId && meId && senderId === meId) ||
    (senderUsername && meUsername && senderUsername === meUsername)
  ) {
    return { ...base, decision: "drop", allow: false, reason: "self_loop" };
  }

  if (!from?.is_bot) {
    return { ...base, decision: "allow", allow: true, reason: "human_sender" };
  }

  if (config.killSwitch) {
    return { ...base, decision: "drop", allow: false, reason: "kill_switch" };
  }

  if (config.maxDepth != null && metadata?.depth != null && metadata.depth > config.maxDepth) {
    return { ...base, decision: "drop", allow: false, reason: "max_depth_exceeded" };
  }

  if (config.maxHops != null && metadata?.hops != null && metadata.hops > config.maxHops) {
    return { ...base, decision: "drop", allow: false, reason: "max_hops_exceeded" };
  }

  if (!config.enabled) {
    return { ...base, decision: "drop", allow: false, reason: "disabled_bot_sender" };
  }

  if (senderUsername && normalizedAllowUsernames.includes(senderUsername)) {
    return { ...base, decision: "allow", allow: true, reason: "allowlisted_bot_sender" };
  }

  return { ...base, decision: "drop", allow: false, reason: "unknown_bot_sender" };
}
