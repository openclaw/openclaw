// Telegram rich message helpers cover Bot API methods newer than current grammY types.
import type { Bot } from "grammy";

type TelegramChatId = Parameters<Bot["api"]["sendMessage"]>[0];
type TelegramApi = Bot["api"];
type TelegramRichMessageParams = Record<string, unknown>;
type TelegramSendRichMessagePayload = TelegramRichMessageParams & {
  chat_id: TelegramChatId;
  rich_message: InputRichMessage;
};
type TelegramSendRichMessageDraftPayload = TelegramRichMessageParams & {
  chat_id: TelegramChatId;
  draft_id: number;
  rich_message: InputRichMessage;
};

type InputRichMessageOptions = {
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
};

export type InputRichMessage =
  | (InputRichMessageOptions & {
      html: string;
      markdown?: never;
    })
  | (InputRichMessageOptions & {
      html?: never;
      markdown: string;
    });

type TelegramRichMessageRawApi = {
  sendRichMessage?: (payload: TelegramSendRichMessagePayload) => Promise<unknown>;
  sendRichMessageDraft?: (payload: TelegramSendRichMessageDraftPayload) => Promise<unknown>;
};

export function normalizeInputRichMessage(richMessage: InputRichMessage): InputRichMessage {
  const html = "html" in richMessage ? richMessage.html : undefined;
  const markdown = "markdown" in richMessage ? richMessage.markdown : undefined;
  const hasHtml = html !== undefined;
  const hasMarkdown = markdown !== undefined;

  if (hasHtml === hasMarkdown) {
    throw new Error("Telegram rich message must specify exactly one of html or markdown.");
  }

  const kind = hasHtml ? "html" : "markdown";
  const content = hasHtml ? html : markdown;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`Telegram rich message ${kind} must not be empty.`);
  }

  const flags = {
    ...(richMessage.is_rtl !== undefined ? { is_rtl: richMessage.is_rtl } : {}),
    ...(richMessage.skip_entity_detection !== undefined
      ? { skip_entity_detection: richMessage.skip_entity_detection }
      : {}),
  };

  return hasHtml ? { html: content, ...flags } : { markdown: content, ...flags };
}

export async function sendTelegramRichMessage(params: {
  api: TelegramApi;
  chatId: TelegramChatId;
  richMessage: InputRichMessage;
  methodParams?: TelegramRichMessageParams;
}): Promise<unknown> {
  const sendRichMessage = (params.api.raw as TelegramRichMessageRawApi).sendRichMessage;
  if (typeof sendRichMessage !== "function") {
    throw new Error("Telegram Bot API client does not expose sendRichMessage.");
  }

  return await sendRichMessage.call(params.api.raw, {
    ...params.methodParams,
    chat_id: params.chatId,
    rich_message: normalizeInputRichMessage(params.richMessage),
  });
}

export async function sendTelegramRichMessageDraft(params: {
  api: TelegramApi;
  chatId: TelegramChatId;
  draftId: number;
  richMessage: InputRichMessage;
  methodParams?: TelegramRichMessageParams;
}): Promise<unknown> {
  const sendRichMessageDraft = (params.api.raw as TelegramRichMessageRawApi).sendRichMessageDraft;
  if (typeof sendRichMessageDraft !== "function") {
    throw new Error("Telegram Bot API client does not expose sendRichMessageDraft.");
  }

  return await sendRichMessageDraft.call(params.api.raw, {
    ...params.methodParams,
    chat_id: params.chatId,
    draft_id: params.draftId,
    rich_message: normalizeInputRichMessage(params.richMessage),
  });
}
