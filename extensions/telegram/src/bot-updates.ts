import type { Message } from "@grammyjs/types";
import { createDedupeCache } from "openclaw/plugin-sdk/core";
import type { TelegramContext } from "./bot/types.js";

const MEDIA_GROUP_TIMEOUT_MS = 500;
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 60_000;
const RECENT_TELEGRAM_UPDATE_MAX = 2000;
// Consecutive redelivery of the same update_id across clean polling restarts is a strong signal
// that this process is stuck on a poisoned update. After a few repeats we prefer dropping that
// single update over allowing an unbounded replay storm.
const TELEGRAM_REPLAY_GUARD_SKIP_THRESHOLD = 4;

type TelegramReplayGuardState = {
  updateId: number;
  count: number;
};

const telegramReplayGuardState = new Map<string, TelegramReplayGuardState>();

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
  if (typeof chatId !== "undefined" && typeof messageId === "number") {
    return `message:${chatId}:${messageId}`;
  }
  return undefined;
};

export const createTelegramUpdateDedupe = () =>
  createDedupeCache({
    ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
    maxSize: RECENT_TELEGRAM_UPDATE_MAX,
  });

export function observeTelegramReplayCandidate(params: {
  accountKey: string;
  updateId: number;
  skipThreshold?: number;
}): { count: number; skip: boolean } {
  const skipThreshold = params.skipThreshold ?? TELEGRAM_REPLAY_GUARD_SKIP_THRESHOLD;
  const current = telegramReplayGuardState.get(params.accountKey);
  if (!current || current.updateId !== params.updateId) {
    telegramReplayGuardState.set(params.accountKey, {
      updateId: params.updateId,
      count: 1,
    });
    return { count: 1, skip: false };
  }

  const count = current.count + 1;
  telegramReplayGuardState.set(params.accountKey, {
    updateId: params.updateId,
    count,
  });
  return {
    count,
    skip: count >= skipThreshold,
  };
}

export function noteTelegramReplayUpdateCompleted(params: {
  accountKey: string;
  updateId: number;
}): void {
  const current = telegramReplayGuardState.get(params.accountKey);
  if (!current || params.updateId >= current.updateId) {
    telegramReplayGuardState.delete(params.accountKey);
  }
}

export function resetTelegramReplayGuardStateForTests(): void {
  telegramReplayGuardState.clear();
}

export { MEDIA_GROUP_TIMEOUT_MS, TELEGRAM_REPLAY_GUARD_SKIP_THRESHOLD };
