// Telegram plugin module implements group history window behavior.
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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

export function selectTelegramGroupHistoryAfterLastSelf(
  entries: readonly HistoryEntry[],
): HistoryEntry[] {
  const lastSelfIndex = entries.findLastIndex((entry) => isTelegramSelfSenderName(entry.sender));
  return lastSelfIndex === -1 ? [...entries] : entries.slice(lastSelfIndex + 1);
}

export function isTelegramChatWindowPromptContext(entry: TelegramPromptContextEntry): boolean {
  return entry.source === "telegram" && entry.type === "chat_window";
}

export function buildTelegramGroupHistoryPromptContext(params: {
  promptContext: TelegramPromptContextEntry[];
  entries: HistoryEntry[];
  observeMessages?: boolean;
  threadId?: number;
}): TelegramPromptContextEntry[] {
  const chatWindowIndex = params.promptContext.findIndex(isTelegramChatWindowPromptContext);
  const baseEntry = params.promptContext[chatWindowIndex];
  const basePayload = isRecord(baseEntry?.payload) ? baseEntry.payload : undefined;
  let retainedCacheContext: TelegramPromptContextEntry | undefined;
  const messagesByKey = new Map<string, Record<string, unknown>>();
  for (const entry of params.entries) {
    const message = {
      message_id: entry.messageId,
      sender: entry.sender,
      timestamp_ms: entry.timestamp,
      body: entry.body,
    };
    const key = telegramPromptMessageKey(message);
    if (key) {
      messagesByKey.set(key, message);
    }
  }
  for (const message of Array.isArray(basePayload?.messages) ? basePayload.messages : []) {
    if (!isRecord(message)) {
      continue;
    }
    const key = telegramPromptMessageKey(message);
    // Pending windows must not resurrect cleared chatter from the cache. Observation
    // explicitly retains it; native topic identity prevents leaks during routing recovery.
    if (
      key &&
      (messagesByKey.has(key) ||
        message.is_reply_target === true ||
        (params.observeMessages &&
          message.thread_id === (params.threadId != null ? String(params.threadId) : undefined)))
    ) {
      messagesByKey.set(key, message);
      retainedCacheContext = baseEntry;
    }
  }
  if (messagesByKey.size === 0) {
    return params.promptContext.filter((_, index) => index !== chatWindowIndex);
  }
  const mergedMessages = [...messagesByKey.values()].toSorted((left, right) => {
    const leftTimestamp = typeof left["timestamp_ms"] === "number" ? left["timestamp_ms"] : 0;
    const rightTimestamp = typeof right["timestamp_ms"] === "number" ? right["timestamp_ms"] : 0;
    return leftTimestamp - rightTimestamp;
  });
  const mergedEntry: TelegramPromptContextEntry = {
    // Projection dedupe belongs to retained cache content, not the replacement pending window.
    ...retainedCacheContext,
    label: "Conversation context",
    source: baseEntry?.source ?? "telegram",
    type: "chat_window",
    payload: {
      ...(retainedCacheContext ? basePayload : undefined),
      order: "chronological",
      relation: "selected_for_current_message",
      messages: mergedMessages,
    },
  };
  if (!baseEntry) {
    return [...params.promptContext, mergedEntry];
  }
  return params.promptContext.map((entry, index) =>
    index === chatWindowIndex ? mergedEntry : entry,
  );
}

export function recordTelegramGroupHistoryEntry(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey?: string;
  limit: number;
  entry: HistoryEntry;
}): void {
  if (!params.historyKey) {
    return;
  }
  createChannelHistoryWindow({ historyMap: params.historyMap }).record({
    historyKey: params.historyKey,
    limit: params.limit,
    entry: params.entry,
  });
}
