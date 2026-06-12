// Telegram plugin module implements rich-message Bot API 10.1 shims.
import type { Bot } from "grammy";

export type TelegramInputRichMessage = {
  html?: string;
  markdown?: string;
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

type TelegramRawSendRichMessageParams = {
  chat_id: number | string;
  rich_message: TelegramInputRichMessage;
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  disable_notification?: boolean;
  protect_content?: boolean;
  allow_paid_broadcast?: boolean;
  message_effect_id?: string;
  suggested_post_parameters?: unknown;
  reply_parameters?: unknown;
  reply_markup?: unknown;
};

type TelegramRawSendRichMessageDraftParams = {
  chat_id: number | string;
  draft_id: number;
  rich_message: TelegramInputRichMessage;
  message_thread_id?: number;
};

type TelegramRawEditRichMessageTextParams = {
  business_connection_id?: string;
  chat_id?: number | string;
  message_id?: number;
  inline_message_id?: string;
  rich_message: TelegramInputRichMessage;
  link_preview_options?: unknown;
  reply_markup?: unknown;
};

type TelegramRawApi = {
  sendRichMessage?: (params: TelegramRawSendRichMessageParams) => Promise<unknown>;
  sendRichMessageDraft?: (params: TelegramRawSendRichMessageDraftParams) => Promise<unknown>;
  editMessageText?: (params: TelegramRawEditRichMessageTextParams) => Promise<unknown>;
};

type TelegramDirectSendRichMessage = (
  chatId: number | string,
  richMessage: TelegramInputRichMessage,
  params?: Omit<TelegramRawSendRichMessageParams, "chat_id" | "rich_message">,
) => Promise<unknown>;

type TelegramDirectSendRichMessageDraft = (
  chatId: number | string,
  draftId: number,
  richMessage: TelegramInputRichMessage,
  params?: Omit<TelegramRawSendRichMessageDraftParams, "chat_id" | "draft_id" | "rich_message">,
) => Promise<unknown>;

type TelegramApiWithRichMethods = Bot["api"] & {
  raw?: TelegramRawApi;
  sendRichMessage?: TelegramDirectSendRichMessage;
  sendRichMessageDraft?: TelegramDirectSendRichMessageDraft;
};

const TELEGRAM_RICH_METHOD_UNAVAILABLE_RE =
  /\bmethod is unavailable\b|\bmethod not found\b|\bunknown method\b/i;

function formatTelegramRichError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function resolveTelegramRawApi(api: Bot["api"]): TelegramRawApi | undefined {
  const raw = (api as TelegramApiWithRichMethods).raw;
  return raw && typeof raw === "object" ? raw : undefined;
}

export function isTelegramRichMethodUnavailableError(err: unknown): boolean {
  return TELEGRAM_RICH_METHOD_UNAVAILABLE_RE.test(formatTelegramRichError(err));
}

export function buildTelegramInputRichMessage(htmlText: string): TelegramInputRichMessage {
  return { html: htmlText };
}

export function canSendTelegramRichMessage(params: {
  api: Bot["api"];
  linkPreview?: boolean;
}): boolean {
  if (params.linkPreview === false) {
    return false;
  }
  return resolveSendRichMessageApi(params.api) !== undefined;
}

export function canSendTelegramRichMessageDraft(api: Bot["api"]): boolean {
  return resolveSendRichMessageDraftApi(api) !== undefined;
}

export function canEditTelegramRichMessage(api: Bot["api"]): boolean {
  return resolveEditTelegramRichTextApi(api) !== undefined;
}

export function normalizeTelegramRichSendParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) {
    return {};
  }
  const normalized = { ...params };
  const replyToMessageId = normalized.reply_to_message_id;
  const hasReplyParameters =
    normalized.reply_parameters != null && typeof normalized.reply_parameters === "object";
  if (
    !hasReplyParameters &&
    typeof replyToMessageId === "number" &&
    Number.isFinite(replyToMessageId)
  ) {
    normalized.reply_parameters = {
      message_id: Math.trunc(replyToMessageId),
      allow_sending_without_reply: true,
    };
  }
  delete normalized.reply_to_message_id;
  delete normalized.allow_sending_without_reply;
  return normalized;
}

export async function sendTelegramRichMessage(params: {
  api: Bot["api"];
  chatId: number | string;
  richMessage: TelegramInputRichMessage;
  requestParams?: Omit<TelegramRawSendRichMessageParams, "chat_id" | "rich_message">;
}): Promise<unknown> {
  const sendRichMessage = resolveSendRichMessageApi(params.api);
  if (!sendRichMessage) {
    throw new Error("Telegram Bot API client does not expose sendRichMessage.");
  }
  return await sendRichMessage(params.chatId, params.richMessage, params.requestParams);
}

export async function sendTelegramRichMessageDraft(params: {
  api: Bot["api"];
  chatId: number | string;
  draftId: number;
  richMessage: TelegramInputRichMessage;
  requestParams?: Omit<
    TelegramRawSendRichMessageDraftParams,
    "chat_id" | "draft_id" | "rich_message"
  >;
}): Promise<unknown> {
  const sendRichMessageDraft = resolveSendRichMessageDraftApi(params.api);
  if (!sendRichMessageDraft) {
    throw new Error("Telegram Bot API client does not expose sendRichMessageDraft.");
  }
  return await sendRichMessageDraft(
    params.chatId,
    params.draftId,
    params.richMessage,
    params.requestParams,
  );
}

export async function editTelegramRichMessageText(params: {
  api: Bot["api"];
  chatId: number | string;
  messageId: number;
  richMessage: TelegramInputRichMessage;
  requestParams?: Omit<
    TelegramRawEditRichMessageTextParams,
    "chat_id" | "message_id" | "rich_message"
  >;
}): Promise<unknown> {
  const editRichMessageText = resolveEditTelegramRichTextApi(params.api);
  if (!editRichMessageText) {
    throw new Error("Telegram Bot API client does not expose rich editMessageText.");
  }
  return await editRichMessageText(
    params.chatId,
    params.messageId,
    params.richMessage,
    params.requestParams,
  );
}

function resolveSendRichMessageApi(api: Bot["api"]): TelegramDirectSendRichMessage | undefined {
  const richApi = api as TelegramApiWithRichMethods;
  if (typeof richApi.sendRichMessage === "function") {
    return richApi.sendRichMessage.bind(api as object);
  }
  const raw = resolveTelegramRawApi(api);
  if (typeof raw?.sendRichMessage !== "function") {
    return undefined;
  }
  return async (chatId, richMessage, requestParams) =>
    await raw.sendRichMessage?.({
      chat_id: chatId,
      rich_message: richMessage,
      ...(requestParams ?? {}),
    });
}

function resolveSendRichMessageDraftApi(
  api: Bot["api"],
): TelegramDirectSendRichMessageDraft | undefined {
  const richApi = api as TelegramApiWithRichMethods;
  if (typeof richApi.sendRichMessageDraft === "function") {
    return richApi.sendRichMessageDraft.bind(api as object);
  }
  const raw = resolveTelegramRawApi(api);
  if (typeof raw?.sendRichMessageDraft !== "function") {
    return undefined;
  }
  return async (chatId, draftId, richMessage, requestParams) =>
    await raw.sendRichMessageDraft?.({
      chat_id: chatId,
      draft_id: draftId,
      rich_message: richMessage,
      ...(requestParams ?? {}),
    });
}

function resolveEditTelegramRichTextApi(api: Bot["api"]) {
  const raw = resolveTelegramRawApi(api);
  if (typeof raw?.editMessageText !== "function") {
    return undefined;
  }
  return async (
    chatId: number | string,
    messageId: number,
    richMessage: TelegramInputRichMessage,
    requestParams?: Omit<
      TelegramRawEditRichMessageTextParams,
      "chat_id" | "message_id" | "rich_message"
    >,
  ) =>
    await raw.editMessageText?.({
      chat_id: chatId,
      message_id: messageId,
      rich_message: richMessage,
      ...(requestParams ?? {}),
    });
}
