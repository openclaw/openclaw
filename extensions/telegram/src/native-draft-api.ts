import type { Bot } from "grammy";

export const TELEGRAM_NATIVE_DRAFT_MAX_CHARS = 4096;

const TELEGRAM_DRAFT_ID_STATE_KEY = Symbol.for("openclaw.telegramNativeDraftIdState");

export type TelegramSendMessageDraft = (
  chatId: Parameters<Bot["api"]["sendMessage"]>[0],
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
    entities?: unknown[];
  },
) => Promise<unknown>;

export function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

export function allocateTelegramDraftId(): number {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state =
    (globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] as { nextDraftId?: number } | undefined) ?? {};
  const nextDraftId = Math.trunc(state.nextDraftId ?? 0) + 1;
  state.nextDraftId = nextDraftId;
  globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] = state;
  return nextDraftId;
}

export function normalizeDraftText(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > TELEGRAM_NATIVE_DRAFT_MAX_CHARS
    ? trimmed.slice(0, TELEGRAM_NATIVE_DRAFT_MAX_CHARS)
    : trimmed;
}
