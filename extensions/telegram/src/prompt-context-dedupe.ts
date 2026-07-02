import { stripInlineDirectiveTagsForDisplay } from "openclaw/plugin-sdk/text-chunking";

export type TelegramPromptContextMessageForDedupe = {
  body?: unknown;
  message_id?: unknown;
  timestamp_ms?: unknown;
};

export type MergeTelegramPromptContextMessagesResult<
  TSessionMessage extends TelegramPromptContextMessageForDedupe,
  TCacheMessage extends TelegramPromptContextMessageForDedupe,
> = {
  sessionOnlyPromptMessages: TSessionMessage[];
  promptMessages: Array<TSessionMessage | TCacheMessage>;
};

function promptContextTimestampForSort(message: TelegramPromptContextMessageForDedupe): number {
  return typeof message.timestamp_ms === "number" && Number.isFinite(message.timestamp_ms)
    ? message.timestamp_ms
    : 0;
}

export function resolvePromptContextTextDedupeKey(
  message: TelegramPromptContextMessageForDedupe,
): string | undefined {
  if (typeof message.body !== "string" || !message.body.trim()) {
    return undefined;
  }
  if (typeof message.timestamp_ms !== "number" || !Number.isFinite(message.timestamp_ms)) {
    return undefined;
  }
  const visibleBody = stripInlineDirectiveTagsForDisplay(message.body).text.trim();
  return visibleBody ? `${message.timestamp_ms}:${visibleBody}` : undefined;
}

export function mergeTelegramPromptContextMessages<
  TSessionMessage extends TelegramPromptContextMessageForDedupe,
  TCacheMessage extends TelegramPromptContextMessageForDedupe,
>(params: {
  sessionPromptMessages: readonly TSessionMessage[];
  cachePromptMessages: readonly TCacheMessage[];
}): MergeTelegramPromptContextMessagesResult<TSessionMessage, TCacheMessage> {
  const cacheTextKeys = new Set(
    params.cachePromptMessages
      .map((message) => resolvePromptContextTextDedupeKey(message))
      .filter((key) => key !== undefined),
  );
  const sessionOnlyPromptMessages = params.sessionPromptMessages.filter((message) => {
    const key = resolvePromptContextTextDedupeKey(message);
    return key === undefined || !cacheTextKeys.has(key);
  });
  return {
    sessionOnlyPromptMessages,
    promptMessages: [...sessionOnlyPromptMessages, ...params.cachePromptMessages].toSorted(
      (left, right) => promptContextTimestampForSort(left) - promptContextTimestampForSort(right),
    ),
  };
}
