export type ResolvedFeishuChatType = "p2p" | "group";

export function normalizeFeishuChatType(value: unknown): ResolvedFeishuChatType | undefined {
  if (value === "group" || value === "topic_group") {
    return "group";
  }
  if (value === "p2p") {
    return "p2p";
  }
  return undefined;
}

export function normalizeFeishuChatMode(value: unknown): ResolvedFeishuChatType | undefined {
  if (value === "group" || value === "topic" || value === "topic_group") {
    return "group";
  }
  return value === "p2p" ? "p2p" : undefined;
}

export function resolveFeishuChatType(chat: {
  chat_mode?: unknown;
  chat_type?: unknown;
}): ResolvedFeishuChatType | undefined {
  // im.chat.get uses chat_mode for conversation kind; chat_type is the
  // public/private visibility classification and must not select DM policy.
  return normalizeFeishuChatMode(chat.chat_mode);
}
