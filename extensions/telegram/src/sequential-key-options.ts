import type { ResolvedTelegramAccount } from "./accounts.js";
import type { TelegramSequentialKeyOptions } from "./sequential-key.js";

const TELEGRAM_GENERAL_TOPIC_ID = 1;

export function resolveTelegramScopedGroupConfig(
  telegramCfg: ResolvedTelegramAccount["config"],
  chatId: string | number,
  messageThreadId?: number,
) {
  const groups = telegramCfg.groups;
  const direct = telegramCfg.direct;
  const chatIdStr = String(chatId);
  const isDm = !chatIdStr.startsWith("-");

  if (isDm) {
    const groupConfig = direct?.[chatIdStr] ?? direct?.["*"];
    const topicConfig =
      groupConfig && messageThreadId != null
        ? groupConfig.topics?.[String(messageThreadId)]
        : undefined;
    return { groupConfig, topicConfig };
  }

  const groupConfig = groups?.[chatIdStr] ?? groups?.["*"];
  const topicConfig =
    groupConfig && messageThreadId != null
      ? groupConfig.topics?.[String(messageThreadId)]
      : undefined;
  return { groupConfig, topicConfig };
}

export function createTelegramSequentialKeyOptions(
  telegramCfg: ResolvedTelegramAccount["config"],
): TelegramSequentialKeyOptions {
  return {
    isConfiguredForumThread: ({ chatId, messageThreadId }) => {
      const resolvedThreadId = messageThreadId ?? TELEGRAM_GENERAL_TOPIC_ID;
      const { topicConfig } = resolveTelegramScopedGroupConfig(
        telegramCfg,
        chatId,
        resolvedThreadId,
      );
      return Boolean(topicConfig);
    },
  };
}
