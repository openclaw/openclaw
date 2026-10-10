import type { UserFromGetMe } from "grammy/types";

export type TelegramBotInfo = UserFromGetMe;

export function normalizeTelegramBotInfo(value: unknown): TelegramBotInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const bot = value as Record<string, unknown>;
  if (
    typeof bot.id !== "number" ||
    bot.is_bot !== true ||
    typeof bot.first_name !== "string" ||
    typeof bot.username !== "string"
  ) {
    return undefined;
  }
  return {
    id: bot.id,
    is_bot: true,
    first_name: bot.first_name,
    username: bot.username,
    ...(typeof bot.last_name === "string" ? { last_name: bot.last_name } : {}),
    ...(typeof bot.language_code === "string" ? { language_code: bot.language_code } : {}),
    can_join_groups: bot.can_join_groups === true,
    can_read_all_group_messages: bot.can_read_all_group_messages === true,
    can_manage_bots: bot.can_manage_bots === true,
    supports_inline_queries: bot.supports_inline_queries === true,
    supports_join_request_queries: bot.supports_join_request_queries === true,
    can_connect_to_business: bot.can_connect_to_business === true,
    has_main_web_app: bot.has_main_web_app === true,
    has_topics_enabled: bot.has_topics_enabled === true,
    allows_users_to_create_topics: bot.allows_users_to_create_topics === true,
  };
}
