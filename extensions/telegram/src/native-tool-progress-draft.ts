// Telegram plugin module implements native tool progress draft behavior.
import type { Bot } from "grammy";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  buildTelegramInputRichMessage,
  canSendTelegramRichMessageDraft,
  isTelegramRichMethodUnavailableError,
  sendTelegramRichMessageDraft,
} from "./rich-message.js";

const TELEGRAM_NATIVE_DRAFT_MAX_CHARS = 4096;
const TELEGRAM_DRAFT_ID_STATE_KEY = Symbol.for("openclaw.telegramNativeDraftIdState");

type TelegramSendMessageDraft = (
  chatId: Parameters<Bot["api"]["sendMessage"]>[0],
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
    entities?: unknown[];
  },
) => Promise<unknown>;

type NativeTelegramDraftSender = {
  mode: "rich" | "plain";
  send: (
    chatId: Parameters<Bot["api"]["sendMessage"]>[0],
    draftId: number,
    text: string,
    params?: {
      message_thread_id?: number;
    },
  ) => Promise<unknown>;
};

export type NativeTelegramToolProgressDraft = {
  update: (text: string) => Promise<boolean>;
  stop: () => void;
};

function resolvePlainSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function resolveNativeTelegramDraftSender(api: Bot["api"]): NativeTelegramDraftSender | undefined {
  const sendPlainDraft = resolvePlainSendMessageDraftApi(api);
  if (canSendTelegramRichMessageDraft(api)) {
    return {
      mode: "rich",
      send: async (chatId, draftId, text, params) => {
        const htmlText = renderTelegramHtmlText(text, { textMode: "html" });
        try {
          return await sendTelegramRichMessageDraft({
            api,
            chatId,
            draftId,
            richMessage: buildTelegramInputRichMessage(htmlText),
            requestParams: params,
          });
        } catch (err) {
          if (!isTelegramRichMethodUnavailableError(err) || !sendPlainDraft) {
            throw err;
          }
          return await sendPlainDraft(chatId, draftId, text, params);
        }
      },
    };
  }
  if (!sendPlainDraft) {
    return undefined;
  }
  return {
    mode: "plain",
    send: async (chatId, draftId, text, params) =>
      await sendPlainDraft(chatId, draftId, text, params),
  };
}

function allocateTelegramDraftId(): number {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state =
    (globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] as { nextDraftId?: number } | undefined) ?? {};
  const nextDraftId = Math.trunc(state.nextDraftId ?? 0) + 1;
  state.nextDraftId = nextDraftId;
  globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] = state;
  return nextDraftId;
}

function normalizeDraftText(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > TELEGRAM_NATIVE_DRAFT_MAX_CHARS
    ? trimmed.slice(0, TELEGRAM_NATIVE_DRAFT_MAX_CHARS)
    : trimmed;
}

export function createNativeTelegramToolProgressDraft(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  thread?: TelegramThreadSpec | null;
  log?: (message: string) => void;
}): NativeTelegramToolProgressDraft | undefined {
  const draftSender = resolveNativeTelegramDraftSender(params.api);
  if (!draftSender) {
    return undefined;
  }

  const draftId = allocateTelegramDraftId();
  const threadParams = buildTelegramThreadParams(params.thread) ?? {};
  let stopped = false;
  let lastSentText: string | undefined;

  return {
    update: async (text: string): Promise<boolean> => {
      if (stopped) {
        return false;
      }
      const normalizedText = normalizeDraftText(text);
      if (!normalizedText) {
        return false;
      }
      if (normalizedText === lastSentText) {
        return true;
      }
      try {
        await draftSender.send(
          params.chatId,
          draftId,
          normalizedText,
          Object.keys(threadParams).length > 0 ? threadParams : undefined,
        );
        lastSentText = normalizedText;
        return true;
      } catch (err) {
        stopped = true;
        params.log?.(`telegram native tool-progress draft disabled: ${formatErrorMessage(err)}`);
        return false;
      }
    },
    stop: () => {
      stopped = true;
    },
  };
}
