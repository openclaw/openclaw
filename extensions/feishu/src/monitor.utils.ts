export type FeishuMessageRecalledEvent = {
  message_id?: string;
  chat_id?: string;
  recall_time?: string;
  action_time?: string;
  operator_id?: unknown;
  user_id?: unknown;
  deleter_id?: unknown;
  message?: unknown;
};

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function pickFirstString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveOpenIdLike(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return pickFirstString(
    asNonEmptyString(record.open_id),
    asNonEmptyString(record.user_id),
    asNonEmptyString(record.union_id),
    resolveOpenIdLike(record.sender_id),
    resolveOpenIdLike(record.id),
    resolveOpenIdLike(record.user),
  );
}

export function buildRecalledEventSummary(eventData: unknown): {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  senderOpenId: string;
  rootId: string;
  threadId: string;
  recallTime: string;
} {
  const event = (eventData as FeishuMessageRecalledEvent | undefined) ?? {};
  const message = asRecord(event.message);
  const messageSender = asRecord(message?.sender);
  return {
    messageId:
      pickFirstString(asNonEmptyString(event.message_id), asNonEmptyString(message?.message_id)) ??
      "unknown",
    chatId:
      pickFirstString(asNonEmptyString(event.chat_id), asNonEmptyString(message?.chat_id)) ??
      "unknown",
    operatorOpenId:
      pickFirstString(
        resolveOpenIdLike(event.operator_id),
        resolveOpenIdLike(event.deleter_id),
        resolveOpenIdLike(event.user_id),
        resolveOpenIdLike(message?.recalled_by),
        resolveOpenIdLike(message?.deleted_by),
      ) ?? "unknown",
    senderOpenId:
      pickFirstString(resolveOpenIdLike(message?.sender_id), resolveOpenIdLike(messageSender)) ??
      "unknown",
    rootId: asNonEmptyString(message?.root_id) ?? "unknown",
    threadId: asNonEmptyString(message?.thread_id) ?? "unknown",
    recallTime:
      pickFirstString(
        asNonEmptyString(event.recall_time),
        asNonEmptyString(event.action_time),
        asNonEmptyString(message?.update_time),
      ) ?? "unknown",
  };
}
