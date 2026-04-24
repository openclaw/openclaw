import type { Message } from "@grammyjs/types";
import { createDedupeCache } from "openclaw/plugin-sdk/infra-runtime";
import type { TelegramContext } from "./bot/types.js";

const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_MAX = 2000;
const RECENT_TELEGRAM_UPDATE_ID_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_ID_MAX = 512;

export type MediaGroupEntry = {
  messages: Array<{
    msg: Message;
    ctx: TelegramContext;
  }>;
  timer: ReturnType<typeof setTimeout>;
};

export type TelegramUpdateKeyContext = {
  update?: {
    update_id?: number;
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
  };
  update_id?: number;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  callbackQuery?: { id?: string; message?: Message };
};

export const resolveTelegramUpdateId = (ctx: TelegramUpdateKeyContext) =>
  ctx.update?.update_id ?? ctx.update_id;

export const buildTelegramUpdateKey = (ctx: TelegramUpdateKeyContext) => {
  const updateId = resolveTelegramUpdateId(ctx);
  if (typeof updateId === "number") {
    return `update:${updateId}`;
  }
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId) {
    return `callback:${callbackId}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.callbackQuery?.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if (chatId !== undefined && typeof messageId === "number") {
    return `message:${chatId}:${messageId}`;
  }
  return undefined;
};

export const createTelegramUpdateDedupe = () =>
  createDedupeCache({
    ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
    maxSize: RECENT_TELEGRAM_UPDATE_MAX,
  });

// Second-line defense keyed strictly on Telegram update.update_id. Backstops the
// broader dedupe when the transport is force-restarted mid-turn and Telegram
// replays updates whose offset write has not yet landed on disk.
export const createTelegramUpdateIdDedupe = () =>
  createDedupeCache({
    ttlMs: RECENT_TELEGRAM_UPDATE_ID_TTL_MS,
    maxSize: RECENT_TELEGRAM_UPDATE_ID_MAX,
  });

export const telegramUpdateIdDedupeKey = (updateId: number) => `update_id:${updateId}`;

export { MEDIA_GROUP_TIMEOUT_MS };
