// Telegram plugin module implements group history window behavior.
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";

const TELEGRAM_GROUP_HISTORY_SELF_SUFFIX = " (you)";

export function buildTelegramGroupHistorySelfSender(name: string): string {
  return `${name}${TELEGRAM_GROUP_HISTORY_SELF_SUFFIX}`;
}

function isTelegramGroupHistorySelfEntry(entry: HistoryEntry): boolean {
  return entry.sender.endsWith(TELEGRAM_GROUP_HISTORY_SELF_SUFFIX);
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
    if (entryKeys.size === 0) {
      return [];
    }
    const payload = telegramChatWindowPayload(entry);
    const messages = telegramPromptMessages(payload).filter((message) => {
      const key = telegramPromptMessageKey(message);
      return Boolean(key && entryKeys.has(key));
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

export function mergeTelegramGroupHistoryPromptContext(params: {
  promptContext: TelegramPromptContextEntry[];
  entries: HistoryEntry[];
}): TelegramPromptContextEntry[] {
  if (params.entries.length === 0) {
    return params.promptContext;
  }
  const historyMessages = params.entries.map((entry) => ({
    ...(entry.messageId ? { message_id: entry.messageId } : {}),
    sender: entry.sender,
    ...(entry.timestamp !== undefined ? { timestamp_ms: entry.timestamp } : {}),
    body: entry.body,
  }));
  const chatWindowIndex = params.promptContext.findIndex(isTelegramChatWindowPromptContext);
  const baseEntry = params.promptContext[chatWindowIndex];
  const basePayload = telegramChatWindowPayload(baseEntry);
  const existingMessages = telegramPromptMessages(basePayload);
  const messagesByKey = new Map<string, Record<string, unknown>>();
  for (const message of [...historyMessages, ...existingMessages]) {
    const key = telegramPromptMessageKey(message);
    if (key) {
      messagesByKey.set(key, message);
    }
  }
  const mergedMessages = [...messagesByKey.values()].toSorted((left, right) => {
    const leftTimestamp = typeof left["timestamp_ms"] === "number" ? left["timestamp_ms"] : 0;
    const rightTimestamp = typeof right["timestamp_ms"] === "number" ? right["timestamp_ms"] : 0;
    return leftTimestamp - rightTimestamp;
  });
  const mergedEntry: TelegramPromptContextEntry = {
    label: "Conversation context",
    source: baseEntry?.source ?? "telegram",
    type: "chat_window",
    payload: {
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
