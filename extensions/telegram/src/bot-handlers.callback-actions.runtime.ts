import type { Message } from "grammy/types";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import { buildTelegramThreadParams, resolveTelegramThreadSpec } from "./bot/helpers.js";
import { buildInlineKeyboard } from "./send.js";

export type TelegramCallbackButton = {
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
};

export function createTelegramCallbackMessageActions(params: {
  bot: RegisterTelegramHandlerParams["bot"];
  callbackMessage: Message;
  isGroup: boolean;
  isForum: boolean;
}) {
  const { bot, callbackMessage, isGroup, isForum } = params;
  const callbackBusinessParams =
    callbackMessage.business_connection_id !== undefined
      ? { business_connection_id: callbackMessage.business_connection_id }
      : undefined;
  const withCallbackBusinessParams = <T extends object>(value: T) =>
    callbackBusinessParams ? { ...callbackBusinessParams, ...value } : value;

  const editCallbackMessage = async (
    text: string,
    editParams?: Parameters<typeof bot.api.editMessageText>[3],
  ) =>
    await bot.api.editMessageText(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      text,
      editParams ? withCallbackBusinessParams(editParams) : callbackBusinessParams,
    );

  const clearCallbackButtons = async () =>
    await bot.api.editMessageReplyMarkup(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      withCallbackBusinessParams({ reply_markup: { inline_keyboard: [] } }),
    );

  const editCallbackButtons = async (buttons: TelegramCallbackButton[][]) =>
    await bot.api.editMessageReplyMarkup(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      withCallbackBusinessParams({
        reply_markup: buildInlineKeyboard(buttons) ?? { inline_keyboard: [] },
      }),
    );

  const deleteCallbackMessage = async () =>
    await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);

  const replyToCallbackChat = async (
    text: string,
    replyParams?: Parameters<typeof bot.api.sendMessage>[2],
  ) => {
    const threadParams = buildTelegramThreadParams(
      resolveTelegramThreadSpec({
        isGroup,
        isForum,
        messageThreadId: callbackMessage.message_thread_id,
      }),
    );
    const topicParams = {
      ...callbackBusinessParams,
      ...threadParams,
      ...(callbackMessage.direct_messages_topic?.topic_id != null
        ? { direct_messages_topic_id: callbackMessage.direct_messages_topic.topic_id }
        : {}),
    };
    const mergedParams =
      Object.keys(topicParams).length > 0 || replyParams
        ? { ...topicParams, ...replyParams }
        : replyParams;
    return await bot.api.sendMessage(callbackMessage.chat.id, text, mergedParams);
  };

  return {
    editCallbackMessage,
    clearCallbackButtons,
    editCallbackButtons,
    deleteCallbackMessage,
    replyToCallbackChat,
  };
}

export type TelegramCallbackMessageActions = ReturnType<
  typeof createTelegramCallbackMessageActions
>;
