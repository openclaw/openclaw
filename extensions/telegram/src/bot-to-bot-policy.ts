export type TelegramBotToBotPolicyConfig = {
  enabled?: boolean;
  killSwitch?: boolean;
  allowBotIds?: Array<string | number>;
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
};

export type TelegramBotToBotPolicyReason =
  | "human_sender"
  | "self_loop"
  | "kill_switch"
  | "disabled_bot_sender"
  | "allowlisted_bot_sender"
  | "unknown_bot_sender";

export type TelegramBotToBotPolicyDecision = {
  decision: "allow" | "drop";
  allow: boolean;
  reason: TelegramBotToBotPolicyReason;
  senderId?: string;
  senderUsername?: string;
  normalizedAllowBotIds: string[];
  dedupeKey?: string;
  senderScopeKey?: string;
};

export function normalizeTelegramBotToBotUsername(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/^@+/u, "").toLowerCase();
  return normalized ? normalized : undefined;
}

export function normalizeTelegramBotToBotId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return undefined;
  }
  const normalized = trimmed.replace(/^0+/u, "") || "0";
  return normalized === "0" ? undefined : normalized;
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
  const senderId = normalizeTelegramBotToBotId(from?.id);
  const meId = normalizeTelegramBotToBotId(me?.id);
  const senderUsername = normalizeTelegramBotToBotUsername(from?.username);
  const normalizedAllowBotIds = (config.allowBotIds ?? [])
    .map((entry) => normalizeTelegramBotToBotId(entry))
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
    chatId && senderId ? ["telegram-bot-to-bot", accountId, chatId, senderId].join(":") : undefined;
  const base = {
    senderId,
    senderUsername,
    normalizedAllowBotIds,
    dedupeKey,
    senderScopeKey,
  };

  if (senderId && meId && senderId === meId) {
    return { ...base, decision: "drop", allow: false, reason: "self_loop" };
  }

  if (!from?.is_bot) {
    return { ...base, decision: "allow", allow: true, reason: "human_sender" };
  }

  if (config.killSwitch) {
    return { ...base, decision: "drop", allow: false, reason: "kill_switch" };
  }

  if (!config.enabled) {
    return { ...base, decision: "drop", allow: false, reason: "disabled_bot_sender" };
  }

  if (senderId && normalizedAllowBotIds.includes(senderId)) {
    return { ...base, decision: "allow", allow: true, reason: "allowlisted_bot_sender" };
  }

  return { ...base, decision: "drop", allow: false, reason: "unknown_bot_sender" };
}
