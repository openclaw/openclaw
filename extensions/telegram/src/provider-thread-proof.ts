import {
  resolveTelegramMessageForumFlagHint,
  TELEGRAM_GENERAL_TOPIC_ID,
  type TelegramThreadSpec,
} from "./bot/helpers.js";

type TelegramThreadMessage = {
  message_id?: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  direct_messages_topic?: { topic_id?: number };
  chat?: { type?: string; is_forum?: boolean };
};

function isTelegramNonForumReplyChain(message: TelegramThreadMessage): boolean {
  const chatType = message.chat?.type;
  return (
    (chatType === "group" || chatType === "supergroup") &&
    resolveTelegramMessageForumFlagHint({
      chatType,
      isForum: message.chat?.is_forum,
      isTopicMessage: message.is_topic_message,
    }) !== true
  );
}

export function resolveTelegramProviderObservedThreadId(params: {
  message: TelegramThreadMessage;
  successfulSendThread?: TelegramThreadSpec;
}): number | undefined {
  if (params.successfulSendThread?.scope === "direct-messages") {
    return params.message.direct_messages_topic?.topic_id;
  }
  if (typeof params.message.message_thread_id === "number") {
    // Telegram also sets message_thread_id on reply chains in non-forum groups.
    // Without a requested topic, only forum proof makes it a conversation thread.
    if (
      params.successfulSendThread?.id === undefined &&
      isTelegramNonForumReplyChain(params.message)
    ) {
      return undefined;
    }
    return params.message.message_thread_id;
  }
  return params.message.chat?.type === "supergroup" &&
    params.successfulSendThread?.scope === "forum" &&
    params.successfulSendThread.id === TELEGRAM_GENERAL_TOPIC_ID
    ? TELEGRAM_GENERAL_TOPIC_ID
    : undefined;
}

export function resolveTelegramProviderObservedThreadSpec(params: {
  message: TelegramThreadMessage;
  successfulSendThread?: TelegramThreadSpec;
}): TelegramThreadSpec | undefined {
  const providerThreadId = resolveTelegramProviderObservedThreadId(params);
  const successfulSendThread = params.successfulSendThread;
  if (
    providerThreadId === undefined ||
    successfulSendThread?.id !== providerThreadId ||
    successfulSendThread.scope === "none"
  ) {
    return undefined;
  }
  return { scope: successfulSendThread.scope, id: providerThreadId };
}

export function assertTelegramProviderThread(params: {
  message: TelegramThreadMessage;
  successfulSendThread?: TelegramThreadSpec;
}): void {
  const expectedThreadId = params.successfulSendThread?.id;
  if (expectedThreadId === undefined) {
    return;
  }
  const providerThreadId = resolveTelegramProviderObservedThreadId(params);
  if (providerThreadId !== expectedThreadId) {
    throw new Error(
      `Telegram delivered message ${params.message.message_id ?? "unknown"} to topic ${providerThreadId ?? "unknown"}; expected topic ${expectedThreadId}`,
    );
  }
}
