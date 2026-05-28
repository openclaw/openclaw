/**
 * telegram-push.ts — 主動 Telegram 訊息發送器
 *
 * 提供兩種發送方式：
 * 1. Gateway RPC `send` — 適用於純文字訊息
 * 2. 直接 Telegram Bot API — 適用於帶 inline keyboard / HTML 格式的進階訊息
 *
 * 同時管理「觀察中的 chatId」，讓事件推送知道要發到哪裡。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { callGatewayCompat } from "../gateway-rpc.js";
import { isTelegramMessageNotModifiedText } from "./telegram-not-modified.js";

// ── 型別 ──────────────────────────────────────────────────────────

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

export type TelegramPushMessage = {
  chatId: string | number;
  text: string;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  buttons?: TelegramInlineButton[][];
  silent?: boolean;
  replyToMessageId?: number;
};

export type TelegramEditMessage = {
  chatId: string | number;
  messageId: number;
  text: string;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  buttons?: TelegramInlineButton[][];
};

export type SentMessage = {
  messageId: number;
  chatId: string | number;
};

type RuntimeConfigApi = {
  runtime?: {
    config?: {
      current?: () => unknown;
    };
  };
};

// ── 觀察 ChatId 管理 ──────────────────────────────────────────────

/** 最後互動的 chatId，用於推送通知的預設目標 */
let activeChatId: string | number | null = null;

export function setActiveChatId(chatId: string | number) {
  activeChatId = chatId;
}

export function getActiveChatId(): string | number | null {
  return activeChatId;
}

// ── Bot Token 解析 ─────────────────────────────────────────────────

let cachedBotToken: string | null = null;

function resolveBotToken(api: OpenClawPluginApi): string | null {
  if (cachedBotToken) {
    return cachedBotToken;
  }

  // 1. 從 plugin runtime config 讀取
  try {
    const cfg = recordValue(
      (api as OpenClawPluginApi & RuntimeConfigApi).runtime?.config?.current?.(),
    );
    const channels = recordValue(cfg?.channels);
    const tg = recordValue(channels?.telegram);
    // 直接 botToken
    if (typeof tg?.botToken === "string" && tg.botToken.length > 0) {
      cachedBotToken = tg.botToken;
      return cachedBotToken;
    }
    // tokenFile
    if (typeof tg?.tokenFile === "string" && tg.tokenFile.length > 0) {
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        const token = readFileSync(tg.tokenFile, "utf8").trim();
        if (token) {
          cachedBotToken = token;
          return cachedBotToken;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  // 2. 環境變數
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (envToken) {
    cachedBotToken = envToken;
    return cachedBotToken;
  }

  // 3. 讀 openclaw.json
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ||
      path.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw");
    const cfgPath = path.join(stateDir, "openclaw.json");
    let raw = readFileSync(cfgPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
    const cfg = recordValue(JSON.parse(raw));
    const channels = recordValue(cfg?.channels);
    const tg = recordValue(channels?.telegram);
    if (typeof tg?.botToken === "string" && tg.botToken.length > 0) {
      cachedBotToken = tg.botToken;
      return cachedBotToken;
    }
    if (typeof tg?.tokenFile === "string" && tg.tokenFile.length > 0) {
      const token = readFileSync(tg.tokenFile, "utf8").trim();
      if (token) {
        cachedBotToken = token;
        return cachedBotToken;
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

/** 清除快取（用於測試或 token 輪替） */
export function resetBotTokenCache() {
  cachedBotToken = null;
}

// ── Telegram Bot API 直接呼叫 ──────────────────────────────────────

async function telegramApiCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const apiRoot = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
  const url = `${apiRoot}/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Telegram API ${method} 失敗: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram API ${method} 回傳失敗: ${data.description ?? "unknown"}`);
  }
  return data.result;
}

function buildInlineKeyboardMarkup(buttons: TelegramInlineButton[][]) {
  const inlineKeyboard = buttons
    .map((row) =>
      row
        .filter(
          (button) => typeof button.callback_data === "string" && button.callback_data.length > 0,
        )
        .map((button) =>
          Object.assign({}, button, {
            text: sanitizeInlineButtonLabel(button.text),
          }),
        ),
    )
    .filter((row) => row.length > 0);
  return {
    inline_keyboard: inlineKeyboard,
  };
}

function messageFromUnknownError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
    if (
      typeof message === "number" ||
      typeof message === "boolean" ||
      typeof message === "bigint"
    ) {
      return String(message);
    }
  }
  return "";
}

function sanitizeInlineButtonLabel(text: string): string {
  const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "操作";
}

// ── 公開 API ──────────────────────────────────────────────────────

/**
 * 發送主動訊息到 Telegram。
 * 優先使用 Telegram Bot API 直接呼叫（支援 inline keyboard + HTML）。
 * 如果無 bot token，fallback 到 Gateway `send` RPC。
 */
export async function pushMessage(
  api: OpenClawPluginApi,
  msg: TelegramPushMessage,
): Promise<SentMessage | null> {
  const token = resolveBotToken(api);

  if (token) {
    // 直接 Telegram Bot API — 完整功能
    const body: Record<string, unknown> = {
      chat_id: msg.chatId,
      text: msg.text,
      parse_mode: msg.parseMode ?? "HTML",
      disable_notification: msg.silent ?? false,
    };
    if (msg.buttons?.length) {
      body.reply_markup = buildInlineKeyboardMarkup(msg.buttons);
    }
    if (msg.replyToMessageId) {
      body.reply_to_message_id = msg.replyToMessageId;
    }

    try {
      const result = (await telegramApiCall(token, "sendMessage", body)) as {
        message_id: number;
        chat?: { id: number };
      };
      return {
        messageId: result.message_id,
        chatId: result.chat?.id ?? msg.chatId,
      };
    } catch (err) {
      console.error("[telegram-push] sendMessage 失敗:", err);
      return null;
    }
  }

  // Fallback: Gateway `send` RPC（不支援 inline keyboard）
  try {
    await callGatewayCompat(api, "send", {
      to: String(msg.chatId),
      message: msg.text,
      channel: "telegram",
      idempotencyKey: `push-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return null; // Gateway send 不回傳 message_id
  } catch (err) {
    console.error("[telegram-push] Gateway send 失敗:", err);
    return null;
  }
}

/**
 * 編輯已發送的 Telegram 訊息（用於即時進度更新）。
 */
export async function editMessage(
  api: OpenClawPluginApi,
  msg: TelegramEditMessage,
): Promise<boolean> {
  const token = resolveBotToken(api);
  if (!token) {
    return false;
  }

  const body: Record<string, unknown> = {
    chat_id: msg.chatId,
    message_id: msg.messageId,
    text: msg.text,
    parse_mode: msg.parseMode ?? "HTML",
  };
  if (msg.buttons?.length) {
    body.reply_markup = buildInlineKeyboardMarkup(msg.buttons);
  } else {
    // 清除 inline keyboard
    body.reply_markup = { inline_keyboard: [] };
  }

  try {
    await telegramApiCall(token, "editMessageText", body);
    return true;
  } catch (err) {
    const message = messageFromUnknownError(err);
    if (isTelegramMessageNotModifiedText(message)) {
      return true;
    }
    console.error("[telegram-push] editMessageText 失敗:", err);
    return false;
  }
}

/**
 * 設定訊息 Reaction（用於完成/失敗標記）。
 */
export async function setReaction(
  api: OpenClawPluginApi,
  chatId: string | number,
  messageId: number,
  emoji: string,
): Promise<boolean> {
  const token = resolveBotToken(api);
  if (!token) {
    return false;
  }

  try {
    await telegramApiCall(token, "setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
    return true;
  } catch {
    return false;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
