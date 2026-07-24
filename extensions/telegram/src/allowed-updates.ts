// Telegram plugin module implements allowed updates behavior.
import { API_CONSTANTS } from "grammy";

type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  API_CONSTANTS.DEFAULT_UPDATE_TYPES;

// grammy's DEFAULT_UPDATE_TYPES omits message_reaction, so it must always be opted in.
// channel_post and poll_answer are in the current defaults, but reaction/channel-post/poll-vote
// routing all *depend* on receiving those updates; the idempotent guards below pin that
// dependency so the features keep working if a future grammy/Telegram default ever drops them.
export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  const updates = [...DEFAULT_TELEGRAM_UPDATE_TYPES] as TelegramUpdateType[];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  if (!updates.includes("poll_answer")) {
    updates.push("poll_answer");
  }
  return updates;
}
