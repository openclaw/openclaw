// Telegram plugin module implements group history window behavior.
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

function isTelegramGroupHistorySelfEntry(entry: HistoryEntry): boolean {
  return isTelegramSelfSenderName(entry.sender);
}

function telegramPromptMessageKey(message: Record<string, unknown>): string | undefined {
  const messageId = message["message_id"];
  const body = message["body"];
  const timestampMs = message["timestamp_ms"];
  if (typeof messageId === "string" && messageId.trim()) {
    return `id:${messageId.trim()}`;
  }
  if (typeof body === "string" && typeof timestampMs === "number") {
    return `text:${timestampMs}:${body.trim()}`;
  }
  return undefined;
}

function telegramHistoryEntryKey(entry: HistoryEntry): string | undefined {
  if (entry.messageId?.trim()) {
    return `id:${entry.messageId.trim()}`;
  }
  if (entry.timestamp !== undefined) {
    return `text:${entry.timestamp}:${entry.body.trim()}`;
  }
  return undefined;
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

export function selectTelegramGroupHistoryAfterLastSelf(
  entries: readonly HistoryEntry[],
): HistoryEntry[] {
  const lastSelfIndex = entries.findLastIndex(isTelegramGroupHistorySelfEntry);
  return lastSelfIndex === -1 ? [...entries] : entries.slice(lastSelfIndex + 1);
}

export function isTelegramChatWindowPromptContext(entry: TelegramPromptContextEntry): boolean {
  return entry.source === "telegram" && entry.type === "chat_window";
}

export function retainTelegramGroupHistoryPromptContext(params: {
  promptContext: TelegramPromptContextEntry[];
  entries: HistoryEntry[];
}): TelegramPromptContextEntry[] {
  const entryKeys = new Set(
    params.entries.flatMap((entry) => {
      const key = telegramHistoryEntryKey(entry);
      return key ? [key] : [];
    }),
  );
  return params.promptContext.flatMap((entry) => {
    if (!isTelegramChatWindowPromptContext(entry)) {
      return [entry];
    }
    const payload = telegramChatWindowPayload(entry);
    const messages = telegramPromptMessages(payload).filter((message) => {
      const key = telegramPromptMessageKey(message);
      return message["is_reply_target"] === true || Boolean(key && entryKeys.has(key));
    });
    if (messages.length === 0) {
      return [];
    }
    return [
      {
        ...entry,
        payload: {
          ...payload,
          messages,
        },
      },
    ];
  });
}

/** Derive the legacy inbound-history projection from the selected cache window. */
export function telegramGroupHistoryEntries(
  context: readonly TelegramPromptContextEntry[],
): HistoryEntry[] {
  return context.filter(isTelegramChatWindowPromptContext).flatMap((entry) =>
    telegramPromptMessages(telegramChatWindowPayload(entry)).flatMap((message) => {
      if (typeof message.message_id !== "string") {
        return [];
      }
      return [
        {
          messageId: message.message_id,
          sender: typeof message.sender === "string" ? message.sender : "unknown sender",
          body: typeof message.body === "string" ? message.body : "<media>",
          ...(typeof message.timestamp_ms === "number" ? { timestamp: message.timestamp_ms } : {}),
        },
      ];
    }),
  );
}
