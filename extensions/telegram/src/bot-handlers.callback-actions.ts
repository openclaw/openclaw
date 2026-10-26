import type { Message, User } from "grammy/types";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramCallbackButton } from "./button-types.js";
import type { TelegramQuestionCallback } from "./question-callback-data.js";
import { updateTelegramQuestionRichMessage } from "./question-rich-message.js";
import { buildInlineKeyboard } from "./send.js";

type TelegramCallbackReplyParams = Omit<
  NonNullable<Parameters<RegisterTelegramHandlerParams["bot"]["api"]["sendMessage"]>[2]>,
  "direct_messages_topic_id" | "message_thread_id"
>;
type TelegramCallbackEditParams = Parameters<
  RegisterTelegramHandlerParams["bot"]["api"]["editMessageText"]
>[3];

export type TelegramCallbackMessageActions = ReturnType<
  typeof createTelegramCallbackMessageActions
>;

export function createTelegramCallbackMessageActions(params: {
  bot: RegisterTelegramHandlerParams["bot"];
  callbackMessage: Message;
  threadSpec: TelegramThreadSpec;
}) {
  const { bot, callbackMessage, threadSpec } = params;
  const callbackBusinessParams =
    callbackMessage.business_connection_id !== undefined
      ? { business_connection_id: callbackMessage.business_connection_id }
      : undefined;
  const withCallbackBusinessParams = <T extends object>(value: T) =>
    callbackBusinessParams ? { ...callbackBusinessParams, ...value } : value;

  const editCallbackMessage = async (text: string, editParams?: TelegramCallbackEditParams) => {
    return await bot.api.editMessageText(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      text,
      editParams ? withCallbackBusinessParams(editParams) : callbackBusinessParams,
    );
  };

  const editCallbackButtons = async (buttons: TelegramCallbackButton[][]) => {
    return await bot.api.editMessageReplyMarkup(
      callbackMessage.chat.id,
      callbackMessage.message_id,
      withCallbackBusinessParams({
        reply_markup: buildInlineKeyboard(buttons) ?? { inline_keyboard: [] },
      }),
    );
  };

  const editCallbackQuestionRichMessage = async (input: {
    questionId: string;
    questionIndex?: number;
    selectedOptionIndex?: number;
    mode: "selected" | "completed" | "inactive";
  }): Promise<boolean> => {
    const richMessage = updateTelegramQuestionRichMessage({
      richMessage: callbackMessage.rich_message,
      ...input,
    });
    if (!richMessage) {
      return false;
    }
    try {
      await bot.api.raw.editMessageText({
        chat_id: callbackMessage.chat.id,
        message_id: callbackMessage.message_id,
        rich_message: richMessage,
        ...callbackBusinessParams,
      });
    } catch (error) {
      if (!String(error).includes("message is not modified")) {
        throw error;
      }
    }
    return true;
  };

  const deleteCallbackMessage = async () => {
    return callbackBusinessParams
      ? await bot.api.deleteBusinessMessages(callbackBusinessParams.business_connection_id, [
          callbackMessage.message_id,
        ])
      : await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
  };

  const replyToCallbackChat = async (text: string, replyParams?: TelegramCallbackReplyParams) => {
    const threadParams = buildTelegramThreadParams(threadSpec);
    const mergedParams =
      callbackBusinessParams || threadParams || replyParams
        ? { ...replyParams, ...callbackBusinessParams, ...threadParams }
        : replyParams;
    return await bot.api.sendMessage(callbackMessage.chat.id, text, mergedParams);
  };

  const editCallbackMessageWithButtons = async (
    text: string,
    buttons: TelegramCallbackButton[][],
    extra?: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2" },
  ) => {
    const keyboard = buildInlineKeyboard(buttons);
    const editParams = keyboard ? { reply_markup: keyboard, ...extra } : extra;
    try {
      await editCallbackMessage(text, editParams);
    } catch (editErr) {
      const errStr = String(editErr);
      if (errStr.includes("no text in the message")) {
        try {
          await deleteCallbackMessage();
        } catch {
          await editCallbackButtons([]).catch(() => {});
        }
        await replyToCallbackChat(text, editParams);
      } else if (!errStr.includes("message is not modified")) {
        throw editErr;
      }
    }
  };

  return {
    editCallbackMessage,
    clearCallbackButtons: () => editCallbackButtons([]),
    editCallbackButtons,
    editCallbackQuestionRichMessage,
    editCallbackMessageWithButtons,
    deleteCallbackMessage,
    replyToCallbackChat,
  };
}
type ResolveQuestionParams = Parameters<typeof questionGatewayRuntime.resolveOption>[0];
type QuestionFeedbackMode = "terminal" | "retry" | "custom-input" | "pending";

export async function sendTelegramQuestionFeedback(params: {
  actions: TelegramCallbackMessageActions;
  text: string;
  mode: QuestionFeedbackMode;
  isGroup: boolean;
  user: User;
}): Promise<void> {
  if (params.mode === "terminal") {
    await params.actions.clearCallbackButtons().catch(() => {});
  }
  const groupCustomInput = params.mode === "custom-input" && params.isGroup;
  const text = groupCustomInput ? `${params.user.first_name}, ${params.text}` : params.text;
  await params.actions.replyToCallbackChat(
    text,
    params.mode === "custom-input"
      ? {
          ...(groupCustomInput
            ? {
                // Selective Force Reply targets mentioned users or the sender of the
                // replied-to message. The question is bot-authored, so mention the tapper.
                entities: [
                  {
                    type: "text_mention" as const,
                    offset: 0,
                    length: params.user.first_name.length,
                    user: params.user,
                  },
                ],
              }
            : {}),
          reply_markup: { force_reply: true, selective: groupCustomInput },
        }
      : undefined,
  );
}

export async function handleTelegramQuestionCallback(params: {
  callback: TelegramQuestionCallback;
  cfg: ResolveQuestionParams["cfg"];
  senderId: string;
  authorize?: () => boolean | Promise<boolean>;
  expectedSessionKey?: string;
  feedback: (text: string, mode: QuestionFeedbackMode) => Promise<unknown>;
  updateRichMessage?: TelegramCallbackMessageActions["editCallbackQuestionRichMessage"];
  resolveQuestion?: typeof questionGatewayRuntime.resolveOption;
}): Promise<void> {
  try {
    const request: ResolveQuestionParams = {
      cfg: params.cfg,
      questionId: params.callback.questionId,
      ...(params.callback.intent === "custom-input"
        ? { customInput: true }
        : params.callback.intent === "done"
          ? { done: true }
          : { optionIndex: params.callback.optionIndex, selected: params.callback.selected }),
      ...(params.callback.questionIndex !== undefined
        ? { questionIndex: params.callback.questionIndex }
        : {}),
      senderId: params.senderId,
      expectedSessionKey: params.expectedSessionKey,
      clientDisplayName: "Telegram question",
    };
    const resolve = params.resolveQuestion ?? questionGatewayRuntime.resolveOption;
    const result = params.authorize
      ? await resolve({ ...request, authorize: params.authorize })
      : await resolve(request);
    if (result.status === "denied") {
      return;
    }
    if (params.callback.intent === "custom-input") {
      if (result.status === "already-terminal") {
        const updated = await params
          .updateRichMessage?.({
            questionId: params.callback.questionId,
            questionIndex: params.callback.questionIndex,
            mode: "inactive",
          })
          .catch(() => false);
        if (updated) {
          return;
        }
      }
      const terminal = result.status === "already-terminal";
      await params.feedback(
        terminal
          ? "This question was already answered."
          : params.callback.questionIndex !== undefined && result.status === "custom-input"
            ? `Reply with your answer. To answer out of order, use "${result.questionId}: your answer".`
            : "Reply with your own answer.",
        terminal ? "terminal" : "custom-input",
      );
      return;
    }
    const updated = await params
      .updateRichMessage?.({
        questionId: params.callback.questionId,
        questionIndex: params.callback.questionIndex,
        ...(params.callback.intent === "select"
          ? { selectedOptionIndex: params.callback.optionIndex }
          : {}),
        mode:
          result.status === "answered" || (result.status === "pending" && result.completed)
            ? "completed"
            : result.status === "pending"
              ? "selected"
              : "inactive",
      })
      .catch(() => false);
    if (updated) {
      return;
    }
    await params
      .feedback(
        result.status === "answered"
          ? "Answer submitted."
          : result.status === "pending"
            ? result.completed
              ? "Answer saved. Waiting for the other questions."
              : "Choice saved. Select more or tap Done."
            : "This question was already answered.",
        result.status === "pending" ? "pending" : "terminal",
      )
      .catch(() => {});
  } catch (error) {
    await params.feedback("Could not submit this answer.", "retry").catch(() => {});
    throw error;
  }
}
