// Telegram plugin module implements allowed updates behavior.
import { API_CONSTANTS } from "grammy";
import type { TelegramBotInfo } from "./bot-info.js";

export type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

export const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  API_CONSTANTS.DEFAULT_UPDATE_TYPES;

const TELEGRAM_GUEST_MESSAGE_UPDATE = "guest_message" as TelegramUpdateType;

export type TelegramGuestModeConfig = {
  enabled?: boolean | "auto";
};

export function shouldRequestTelegramGuestUpdates(params: {
  guest?: TelegramGuestModeConfig;
  botInfo?: Pick<TelegramBotInfo, "supports_guest_queries">;
  includeGuest?: boolean;
}): boolean {
  if (typeof params.includeGuest === "boolean") {
    return params.includeGuest;
  }
  const enabled = params.guest?.enabled ?? false;
  if (enabled === true) {
    return true;
  }
  return enabled === "auto" && params.botInfo?.supports_guest_queries === true;
}

export function resolveTelegramAllowedUpdates(params?: {
  guest?: TelegramGuestModeConfig;
  botInfo?: Pick<TelegramBotInfo, "supports_guest_queries">;
  includeGuest?: boolean;
}): ReadonlyArray<TelegramUpdateType> {
  const includeGuest = shouldRequestTelegramGuestUpdates(params ?? {});
  const updates: TelegramUpdateType[] = DEFAULT_TELEGRAM_UPDATE_TYPES.filter(
    (update) => update !== TELEGRAM_GUEST_MESSAGE_UPDATE || includeGuest,
  );
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  if (includeGuest && !updates.includes(TELEGRAM_GUEST_MESSAGE_UPDATE)) {
    updates.push(TELEGRAM_GUEST_MESSAGE_UPDATE);
  }
  return updates;
}
