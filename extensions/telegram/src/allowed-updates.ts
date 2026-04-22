import { createRequire } from "node:module";

// `grammy` is a bundled runtime dependency installed lazily at gateway startup
// by ensureBundledPluginRuntimeDeps.  A top-level static value import causes
// `Cannot find module 'grammy'` during `openclaw update` doctor checks because
// the installer hasn't run yet when Node.js resolves the static import graph.
//
// Solution: keep `import type` (erased at compile time, zero runtime cost) for
// type information, and use a deferred createRequire() call for the one runtime
// value we need (API_CONSTANTS).  This way grammy is only resolved at call-time,
// after the installer has placed it under dist/extensions/telegram/node_modules/.
import type * as grammy from "grammy";

const _require = createRequire(import.meta.url);

function tryLoadGrammyApiConstants():
  | (typeof grammy)["API_CONSTANTS"]
  | undefined {
  try {
    return (_require("grammy") as typeof grammy).API_CONSTANTS;
  } catch {
    return undefined;
  }
}

const FALLBACK_ALL_UPDATE_TYPES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
] as const;

const FALLBACK_DEFAULT_UPDATE_TYPES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message_reaction",
  "message_reaction_count",
  "inline_query",
  "chosen_inline_result",
  "callback_query",
  "shipping_query",
  "pre_checkout_query",
  "poll",
  "poll_answer",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
] as const;

export type TelegramUpdateType =
  | (typeof FALLBACK_ALL_UPDATE_TYPES)[number]
  | (typeof grammy.API_CONSTANTS.ALL_UPDATE_TYPES)[number];

export const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramUpdateType> =
  (tryLoadGrammyApiConstants()?.DEFAULT_UPDATE_TYPES as
    | ReadonlyArray<TelegramUpdateType>
    | undefined) ?? FALLBACK_DEFAULT_UPDATE_TYPES;

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramUpdateType> {
  const updates = [...DEFAULT_TELEGRAM_UPDATE_TYPES] as TelegramUpdateType[];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  return updates;
}
