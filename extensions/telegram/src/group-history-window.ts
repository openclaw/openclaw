import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";

const TELEGRAM_SELF_SENDER_SUFFIX = " (you)";

export function buildTelegramSelfSenderName(
  configuredName?: string,
  telegramIdentity?: { first_name?: string; username?: string },
): string {
  const name =
    configuredName?.trim() ||
    telegramIdentity?.first_name?.trim() ||
    telegramIdentity?.username?.trim() ||
    "OpenClaw";
  return `${name}${TELEGRAM_SELF_SENDER_SUFFIX}`;
}

export function isTelegramSelfSenderName(name: string | undefined): name is string {
  return name?.endsWith(TELEGRAM_SELF_SENDER_SUFFIX) === true;
}

function numericMessageId(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isTelegramHistoryEntryAfterAmbientWatermark(
  entry: Pick<HistoryEntry, "messageId" | "timestamp">,
  watermark: TelegramAmbientTranscriptWatermark | undefined,
): boolean {
  if (!watermark) {
    return true;
  }
  // Exclusive boundary: entries at or before this point are transcript-owned.
  if (entry.timestamp !== undefined && watermark.timestampMs !== undefined) {
    if (entry.timestamp !== watermark.timestampMs) {
      return entry.timestamp > watermark.timestampMs;
    }
    const entryMessageId = numericMessageId(entry.messageId);
    const watermarkMessageId = numericMessageId(watermark.messageId);
    return (
      entryMessageId !== undefined &&
      watermarkMessageId !== undefined &&
      entryMessageId > watermarkMessageId
    );
  }
  const entryMessageId = numericMessageId(entry.messageId);
  const watermarkMessageId = numericMessageId(watermark.messageId);
  if (entryMessageId !== undefined && watermarkMessageId !== undefined) {
    return entryMessageId > watermarkMessageId;
  }
  return entry.messageId !== watermark.messageId;
}

function telegramChatWindowPayload(
  entry: TelegramPromptContextEntry | undefined,
): Record<string, unknown> | undefined {
  return entry?.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
    ? (entry.payload as Record<string, unknown>)
    : undefined;
}

function telegramPromptMessages(payload: Record<string, unknown> | undefined) {
  return Array.isArray(payload?.["messages"])
    ? payload["messages"].filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) && typeof message === "object" && !Array.isArray(message),
      )
    : [];
}

export function isTelegramChatWindowPromptContext(entry: TelegramPromptContextEntry): boolean {
  return entry.source === "telegram" && entry.type === "chat_window";
}

export function telegramPromptContextHistory(
  promptContext: readonly TelegramPromptContextEntry[],
): HistoryEntry[] {
  return promptContext.flatMap((entry) =>
    isTelegramChatWindowPromptContext(entry)
      ? telegramPromptMessages(telegramChatWindowPayload(entry)).flatMap((message) =>
          typeof message["body"] === "string" && typeof message["sender"] === "string"
            ? [
                {
                  sender: message["sender"],
                  body: message["body"],
                  ...(typeof message["message_id"] === "string"
                    ? { messageId: message["message_id"] }
                    : {}),
                  ...(typeof message["timestamp_ms"] === "number"
                    ? { timestamp: message["timestamp_ms"] }
                    : {}),
                },
              ]
            : [],
        )
      : [],
  );
}

export function selectTelegramGroupPromptContext(params: {
  promptContext: readonly TelegramPromptContextEntry[];
  historyLimit: number;
  ambientWatermark?: TelegramAmbientTranscriptWatermark;
  includeBeforeSelf: boolean;
}): TelegramPromptContextEntry[] {
  return params.promptContext.flatMap((entry) => {
    if (!isTelegramChatWindowPromptContext(entry)) {
      return [entry];
    }
    const payload = telegramChatWindowPayload(entry);
    const sourceMessages = telegramPromptMessages(payload);
    const recentMessages =
      params.historyLimit > 0
        ? sourceMessages
            .filter((message) =>
              isTelegramHistoryEntryAfterAmbientWatermark(
                {
                  messageId:
                    typeof message["message_id"] === "string" ? message["message_id"] : undefined,
                  timestamp:
                    typeof message["timestamp_ms"] === "number"
                      ? message["timestamp_ms"]
                      : undefined,
                },
                params.ambientWatermark,
              ),
            )
            .slice(-params.historyLimit)
        : [];
    const lastSelfIndex = params.includeBeforeSelf
      ? -1
      : recentMessages.findLastIndex(
          (message) =>
            typeof message["sender"] === "string" && isTelegramSelfSenderName(message["sender"]),
        );
    const selected = new Set(recentMessages.slice(lastSelfIndex + 1));
    const messages = sourceMessages.filter(
      (message) => message["is_reply_target"] === true || selected.has(message),
    );
    if (messages.length === 0) {
      return [];
    }
    if (messages.length === sourceMessages.length) {
      return [entry];
    }
    // A clipped projection must not hide a complete transcript message.
    const {
      sessionTranscriptDedupeMessageIds: _projectionIds,
      sessionTranscriptAssistantTextDedupeKeys: _assistantTextKeys,
      ...selectedEntry
    } = entry;
    return [{ ...selectedEntry, payload: { ...payload, messages } }];
  });
}
