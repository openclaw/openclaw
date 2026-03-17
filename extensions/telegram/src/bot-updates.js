import { createDedupeCache } from "../../../src/infra/dedupe.js";
const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 6e4;
const RECENT_TELEGRAM_UPDATE_MAX = 2e3;
const resolveTelegramUpdateId = (ctx) => ctx.update?.update_id ?? ctx.update_id;
const buildTelegramUpdateKey = (ctx) => {
  const updateId = resolveTelegramUpdateId(ctx);
  if (typeof updateId === "number") {
    return `update:${updateId}`;
  }
  const callbackId = ctx.callbackQuery?.id;
  if (callbackId) {
    return `callback:${callbackId}`;
  }
  const msg = ctx.message ?? ctx.channelPost ?? ctx.editedChannelPost ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.update?.channel_post ?? ctx.update?.edited_channel_post ?? ctx.callbackQuery?.message;
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if (typeof chatId !== "undefined" && typeof messageId === "number") {
    return `message:${chatId}:${messageId}`;
  }
  return void 0;
};
const createTelegramUpdateDedupe = () => createDedupeCache({
  ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
  maxSize: RECENT_TELEGRAM_UPDATE_MAX
});
export {
  MEDIA_GROUP_TIMEOUT_MS,
  buildTelegramUpdateKey,
  createTelegramUpdateDedupe,
  resolveTelegramUpdateId
};
