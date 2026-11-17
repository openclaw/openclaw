// Telegram widget-query origin prepared before sequentialization.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { lookupTelegramSentWidget } from "./widget-store.js";

/**
 * Where the tapped widget was sent. Telegram's widget_query carries the chat but not the
 * private-chat topic, so the topic comes from OpenClaw's own sent-widget record.
 * `messageThreadId` is absent for a plain private chat or an unknown widget.
 */
export type PreparedTelegramWidgetQuery = { messageThreadId?: number };

const preparedWidgetQueries = new WeakMap<object, PreparedTelegramWidgetQuery>();

function readWidgetQueryOrigin(update: unknown): { chatId: number; messageId: number } | undefined {
  const query = isRecord(update) ? update.widget_query : undefined;
  if (!isRecord(query) || !isRecord(query.chat) || query.chat.type !== "private") {
    return undefined;
  }
  const { id: chatId } = query.chat;
  const { message_id: messageId } = query;
  return typeof chatId === "number" && typeof messageId === "number"
    ? { chatId, messageId }
    : undefined;
}

/** Resolves the tap's topic once, so ingress, the sequentializer and the router share one lane. */
export async function prepareTelegramWidgetQueryContextAsync(params: {
  update: object;
  accountId: string;
}): Promise<void> {
  const origin = readWidgetQueryOrigin(params.update);
  if (!origin || preparedWidgetQueries.has(params.update)) {
    return;
  }
  const sent = await lookupTelegramSentWidget({
    accountId: params.accountId,
    chatId: String(origin.chatId),
    messageId: origin.messageId,
  });
  const threadId = sent?.messageThreadId;
  preparedWidgetQueries.set(
    params.update,
    typeof threadId === "number" && Number.isSafeInteger(threadId) && threadId > 0
      ? { messageThreadId: threadId }
      : {},
  );
}

export function getPreparedTelegramWidgetQuery(
  update: object,
): PreparedTelegramWidgetQuery | undefined {
  return preparedWidgetQueries.get(update);
}

export function recordPreparedTelegramWidgetQuery(
  update: object,
  prepared: PreparedTelegramWidgetQuery,
): void {
  preparedWidgetQueries.set(update, prepared);
}
