import { API_CONSTANTS } from "grammy";

type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];

const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  API_CONSTANTS.DEFAULT_UPDATE_TYPES;

// Bot API 10.4 widget taps. grammY 1.46 types stop at Bot API 10.3; Telegram accepts the name.
const TELEGRAM_WIDGET_QUERY_UPDATE = bindUpdateName("widget_query");

function bindUpdateName(name: string): TelegramUpdateType {
  // SAFETY: Bot API 10.4 lists widget_query as an update type; only grammY's typings predate it.
  return name as TelegramUpdateType;
}

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  // OpenClaw does not request stoppable drafts. Subscribing without a handler
  // would acknowledge the user's stop action without a visible outcome.
  const updates: TelegramUpdateType[] = DEFAULT_TELEGRAM_UPDATE_TYPES.filter(
    (type) => type !== "stopped_message_generation",
  );
  for (const type of ["message_reaction", "channel_post", TELEGRAM_WIDGET_QUERY_UPDATE] as const) {
    if (!updates.includes(type)) {
      updates.push(type);
    }
  }
  return updates;
}
