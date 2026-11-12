import type { Message } from "grammy/types";
import { getTelegramTextParts, resolveTelegramPrimaryMedia } from "./bot/helpers.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";

/** Count user messages rather than title-only service events in a mixed batch. */
export function telegramBufferedUserMessageIds(messages: readonly Message[]): string[] {
  return messages
    .filter(
      (message) =>
        !isTelegramForumServiceMessage(message) ||
        Boolean(getTelegramTextParts(message).text.trim()) ||
        Boolean(resolveTelegramPrimaryMedia(message)),
    )
    .map((message) => String(message.message_id));
}
