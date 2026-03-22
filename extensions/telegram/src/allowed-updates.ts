import { API_CONSTANTS } from "grammy";

type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  const updates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES] as TelegramUpdateType[];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  if (!updates.includes("inline_query")) {
    updates.push("inline_query");
  }
  if (!updates.includes("chosen_inline_result")) {
    updates.push("chosen_inline_result");
  }
  return updates;
}
