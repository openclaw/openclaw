// Telegram plugin module implements allowed updates behavior.
import { API_CONSTANTS } from "grammy";

export type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

export const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  API_CONSTANTS.DEFAULT_UPDATE_TYPES;

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  const updates = [...DEFAULT_TELEGRAM_UPDATE_TYPES] as TelegramUpdateType[];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("message_reaction_count")) {
    updates.push("message_reaction_count");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  return updates;
}
