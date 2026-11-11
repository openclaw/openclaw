import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { asOptionalRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramPromptContextEntry,
} from "./bot-message-context.types.js";
import { resolveCompleteTelegramPromptContextProjectionIds } from "./prompt-context-projection.js";

const TELEGRAM_SELF_SENDER_SUFFIX = " (you)";
const RECENT_SELF_CONTEXT_MAX_AGE_MS = 15 * 60_000;
const RECENT_SELF_CONTEXT_LIMIT = 3;

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
  const { timestamp } = entry;
  const { timestampMs } = watermark;
  const hasTimestamps = timestamp !== undefined && timestampMs !== undefined;
  if (hasTimestamps && timestamp !== timestampMs) {
    return timestamp > timestampMs;
  }
  const entryMessageId = numericMessageId(entry.messageId);
  const watermarkMessageId = numericMessageId(watermark.messageId);
  if (entryMessageId !== undefined && watermarkMessageId !== undefined) {
    return entryMessageId > watermarkMessageId;
  }
  return !hasTimestamps && entry.messageId !== watermark.messageId;
}

function telegramPromptMessages(payload: Record<string, unknown> | undefined) {
  return Array.isArray(payload?.["messages"]) ? payload["messages"].filter(isRecord) : [];
}

export function isTelegramChatWindowPromptContext(entry: TelegramPromptContextEntry): boolean {
  return entry.source === "telegram" && entry.type === "chat_window";
}

/** Ids of unhydrated media the sender posted in the selected chat window, oldest first. */
export function selectTelegramSenderMediaMessageIds(params: {
  promptContext: readonly TelegramPromptContextEntry[];
  senderId: string;
  sinceMs: number;
}): string[] {
  return params.promptContext.flatMap((entry) =>
    isTelegramChatWindowPromptContext(entry)
      ? telegramPromptMessages(asOptionalRecord(entry.payload)).flatMap((message) => {
          const messageId = message["message_id"];
          const timestamp = message["timestamp_ms"];
          return typeof messageId === "string" &&
            message["sender_id"] === params.senderId &&
            typeof message["media_ref"] === "string" &&
            typeof timestamp === "number" &&
            timestamp >= params.sinceMs
            ? [messageId]
            : [];
        })
      : [],
  );
}

export function telegramPromptContextHistory(
  promptContext: readonly TelegramPromptContextEntry[],
): HistoryEntry[] {
  return promptContext.flatMap((entry) =>
    isTelegramChatWindowPromptContext(entry)
      ? telegramPromptMessages(asOptionalRecord(entry.payload)).flatMap((message) =>
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
  currentTimestampMs?: number;
}): TelegramPromptContextEntry[] {
  return params.promptContext.flatMap((entry) => {
    if (!isTelegramChatWindowPromptContext(entry)) {
      return [entry];
    }
    const payload = asOptionalRecord(entry.payload);
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
    const recentSelfMessages: typeof recentMessages = [];
    // Independent outbound notifications may have no canonical assistant turn.
    // Keep recent authenticated self entries as candidates, not reply targets.
    // Their labels are authenticated by the message-context owner before selection.
    const now = params.currentTimestampMs;
    if (!params.includeBeforeSelf && typeof now === "number" && Number.isFinite(now)) {
      for (const message of recentMessages
        .filter((message) => {
          const timestamp = message["timestamp_ms"];
          return (
            typeof message["sender"] === "string" &&
            isTelegramSelfSenderName(message["sender"]) &&
            typeof timestamp === "number" &&
            Number.isFinite(timestamp) &&
            timestamp <= now &&
            now - timestamp <= RECENT_SELF_CONTEXT_MAX_AGE_MS
          );
        })
        .slice(-RECENT_SELF_CONTEXT_LIMIT)) {
        selected.add(message);
        recentSelfMessages.push(message);
      }
    }
    const messages = sourceMessages.filter(
      (message) => message["is_reply_target"] === true || selected.has(message),
    );
    if (messages.length === 0) {
      return [];
    }
    const assistantTextKeys = [
      ...(messages.length === sourceMessages.length
        ? (entry.sessionTranscriptAssistantTextDedupeKeys ?? [])
        : []),
      ...recentSelfMessages.flatMap((message) =>
        typeof message["body"] === "string" && message["body"].trim()
          ? [`body:${message["body"].trim()}`]
          : [],
      ),
    ];
    const priorityMessageIds = recentSelfMessages.flatMap((message) =>
      typeof message["message_id"] === "string" ? [message["message_id"]] : [],
    );
    const recentContextMetadata = {
      ...(assistantTextKeys.length > 0
        ? { sessionTranscriptAssistantTextDedupeKeys: [...new Set(assistantTextKeys)] }
        : {}),
      ...(priorityMessageIds.length > 0
        ? { sessionTranscriptPriorityMessageIds: priorityMessageIds }
        : {}),
    };
    if (messages.length === sourceMessages.length) {
      return [{ ...entry, ...recentContextMetadata }];
    }
    // Clipping unrelated ambient rows must not duplicate a complete final reply;
    // clipping any physical projection part must restore its canonical text.
    const completeProjectionIds = resolveCompleteTelegramPromptContextProjectionIds(
      messages.map((message) =>
        typeof message["message_id"] === "string"
          ? entry.telegramTranscriptProjections?.[message["message_id"]]
          : undefined,
      ),
    );
    const retainedProjectionIds = entry.sessionTranscriptDedupeMessageIds?.filter((id) =>
      completeProjectionIds.has(id),
    );
    const {
      sessionTranscriptDedupeMessageIds: _projectionIds,
      sessionTranscriptAssistantTextDedupeKeys: _assistantTextKeys,
      ...selectedEntry
    } = entry;
    return [
      {
        ...selectedEntry,
        ...recentContextMetadata,
        ...(retainedProjectionIds?.length
          ? { sessionTranscriptDedupeMessageIds: retainedProjectionIds }
          : {}),
        payload: { ...payload, messages },
      },
    ];
  });
}
