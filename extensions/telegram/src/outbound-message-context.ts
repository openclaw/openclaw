// Telegram plugin module implements outbound message context behavior.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { createTelegramMessageCache, resolveTelegramMessageCacheScope } from "./message-cache.js";

type TelegramPromptContextChannelData = {
  promptContextTimestampMs?: unknown;
};

export type TelegramOutboundPromptContextMessage = {
  message_id?: number;
  chat?: { id?: string | number; type?: string; title?: string; username?: string };
  date?: number;
  from?: { id?: number; is_bot?: boolean; first_name?: string; username?: string };
  openclaw_prompt_context_timestamp_ms?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
};

type TelegramOutboundPromptContextAccount = {
  accountId: string;
  name?: string;
};

export function resolveTelegramPromptContextTimestampMs(
  payload: Pick<ReplyPayload, "channelData">,
): number | undefined {
  const telegramData = payload.channelData?.telegram as
    | TelegramPromptContextChannelData
    | undefined;
  const timestamp = telegramData?.promptContextTimestampMs;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

export function withTelegramPromptContextTimestampMs(
  payload: ReplyPayload,
  timestampMs: number | undefined,
): ReplyPayload {
  if (timestampMs === undefined) {
    return payload;
  }
  const telegramData = payload.channelData?.telegram as
    | TelegramPromptContextChannelData
    | undefined;
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      telegram: {
        ...telegramData,
        promptContextTimestampMs: timestampMs,
      },
    },
  };
}

type TelegramOutboundGroupHistoryRecord = {
  chatId: string | number;
  messageId: number;
  text?: string;
  messageThreadId?: number;
  timestamp?: number;
};

type TelegramOutboundGroupHistoryRecorder = (record: TelegramOutboundGroupHistoryRecord) => void;

const outboundGroupHistoryRecorders = new Map<string, TelegramOutboundGroupHistoryRecorder>();

export function registerTelegramOutboundGroupHistoryRecorder(params: {
  accountId: string;
  recorder: TelegramOutboundGroupHistoryRecorder;
}): () => void {
  outboundGroupHistoryRecorders.set(params.accountId, params.recorder);
  return () => {
    if (outboundGroupHistoryRecorders.get(params.accountId) === params.recorder) {
      outboundGroupHistoryRecorders.delete(params.accountId);
    }
  };
}

function resolveOutboundCacheMessageTimestamp(
  msg: TelegramOutboundPromptContextMessage,
): number | undefined {
  if (
    typeof msg.openclaw_prompt_context_timestamp_ms === "number" &&
    Number.isFinite(msg.openclaw_prompt_context_timestamp_ms)
  ) {
    return msg.openclaw_prompt_context_timestamp_ms;
  }
  return typeof msg.date === "number" && Number.isFinite(msg.date) ? msg.date * 1000 : undefined;
}

function inferTelegramChatType(chatId: string | number): "private" | "supergroup" {
  return String(chatId).startsWith("-") ? "supergroup" : "private";
}

function buildOutboundCacheMessage(params: {
  account: TelegramOutboundPromptContextAccount;
  chatId: string | number;
  message: TelegramOutboundPromptContextMessage;
  messageId: number;
  text?: string;
  messageThreadId?: number;
  promptContextTimestampMs?: number;
}): TelegramOutboundPromptContextMessage {
  const chat = params.message.chat ?? {};
  const text = params.message.text ?? params.message.caption ?? params.text;
  return {
    ...params.message,
    message_id: params.messageId,
    ...(params.promptContextTimestampMs !== undefined
      ? { openclaw_prompt_context_timestamp_ms: params.promptContextTimestampMs }
      : {}),
    date:
      typeof params.message.date === "number" && Number.isFinite(params.message.date)
        ? params.message.date
        : Math.floor(Date.now() / 1000),
    chat: {
      id: chat.id ?? params.chatId,
      type: chat.type ?? inferTelegramChatType(params.chatId),
      ...(chat.title ? { title: chat.title } : {}),
      ...(chat.username ? { username: chat.username } : {}),
    },
    from: params.message.from ?? {
      id: 0,
      is_bot: true,
      first_name: params.account.name ?? "OpenClaw",
    },
    ...(text ? { text } : {}),
    ...(params.messageThreadId !== undefined ? { message_thread_id: params.messageThreadId } : {}),
  };
}

export async function recordOutboundMessageForPromptContext(params: {
  cfg: OpenClawConfig;
  account: TelegramOutboundPromptContextAccount;
  chatId: string | number;
  message: TelegramOutboundPromptContextMessage;
  messageId: number;
  text?: string;
  messageThreadId?: number;
  promptContextTimestampMs?: number;
}): Promise<void> {
  try {
    const cacheMessage = buildOutboundCacheMessage(params);
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(resolveStorePath(params.cfg.session?.store)),
    });
    await cache.record({
      accountId: params.account.accountId,
      chatId: params.chatId,
      msg: cacheMessage as Message,
      ...(params.messageThreadId !== undefined ? { threadId: params.messageThreadId } : {}),
    });
    const timestamp = resolveOutboundCacheMessageTimestamp(cacheMessage);
    outboundGroupHistoryRecorders.get(params.account.accountId)?.({
      chatId: params.chatId,
      messageId: params.messageId,
      text: params.text ?? cacheMessage.text ?? cacheMessage.caption,
      ...(params.messageThreadId !== undefined ? { messageThreadId: params.messageThreadId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
  } catch (error) {
    logVerbose(`telegram: failed to record outbound message context: ${String(error)}`);
  }
}
