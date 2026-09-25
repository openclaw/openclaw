// Telegram plugin module implements native media action behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { createTelegramActionGate } from "./accounts.js";
import { readTelegramReplyToMessageId, readTelegramThreadId } from "./action-params.js";
import { sendDiceTelegram, sendStickerTelegram } from "./send.js";
import { getCacheStats, searchStickers } from "./sticker-cache.js";
import { resolveTelegramToken } from "./token.js";

const MISSING_TOKEN_MESSAGE =
  "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.";
const STICKER_DISABLED_MESSAGE =
  "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.";

/**
 * The actions this module owns. The dispatcher narrows on this list instead of calling
 * unconditionally, so its own trailing throw still sees an exhausted union and keeps proving that
 * every Telegram action has a handler.
 */
const TELEGRAM_NATIVE_MEDIA_ACTIONS = [
  "searchSticker",
  "sendDice",
  "sendSticker",
  "stickerCacheStats",
] as const;

export type TelegramNativeMediaActionName = (typeof TELEGRAM_NATIVE_MEDIA_ACTIONS)[number];

const TELEGRAM_NATIVE_MEDIA_ACTION_SET: ReadonlySet<string> = new Set(
  TELEGRAM_NATIVE_MEDIA_ACTIONS,
);

export function isTelegramNativeMediaAction(
  action: string,
): action is TelegramNativeMediaActionName {
  return TELEGRAM_NATIVE_MEDIA_ACTION_SET.has(action);
}

export type TelegramNativeMediaActionContext = {
  action: TelegramNativeMediaActionName;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayClientScopes?: readonly string[];
  isActionEnabled: ReturnType<typeof createTelegramActionGate>;
  notifyVisibleOutboundSuccess: (to: string, messageThreadId?: number | null) => void;
  /** Host-owned send authority: recorded and revalidated at the dispatch boundary. */
  onPlatformSendDispatch?: ChannelMessageActionContext["onPlatformSendDispatch"];
  assertDirectAdapterHandoff?: ChannelMessageActionContext["assertDirectAdapterHandoff"];
};

function readTelegramSendTarget(params: Record<string, unknown>): string {
  return readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
}

/**
 * Dice and stickers are native Telegram message types that carry no text body, so they bypass the
 * text send pipeline and are dispatched here together with the sticker cache queries that serve
 * them.
 */
export async function handleTelegramNativeMediaAction(
  context: TelegramNativeMediaActionContext,
): Promise<AgentToolResult<unknown>> {
  const { action, params, cfg, accountId, isActionEnabled } = context;

  if (action === "sendDice") {
    if (!isActionEnabled("sendMessage")) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    const to = readTelegramSendTarget(params);
    const emoji = readStringParam(params, "diceEmoji");
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(MISSING_TOKEN_MESSAGE);
    }
    const result = await sendDiceTelegram(to, emoji ?? undefined, {
      cfg,
      token,
      accountId: accountId ?? undefined,
      silent: readBooleanParam(params, "silent"),
      replyToMessageId: replyToMessageId ?? undefined,
      messageThreadId: messageThreadId ?? undefined,
      gatewayClientScopes: context.gatewayClientScopes,
      onPlatformSendDispatch: context.onPlatformSendDispatch,
      assertPlatformSendAuthorized: context.assertDirectAdapterHandoff,
    });
    context.notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      emoji: result.emoji,
      value: result.value,
    });
  }

  if (action === "sendSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(STICKER_DISABLED_MESSAGE);
    }
    const to = readTelegramSendTarget(params);
    const fileId =
      readStringParam(params, "fileId") ?? readStringArrayParam(params, "stickerId")?.[0];
    if (!fileId) {
      throw new Error("fileId is required.");
    }
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(MISSING_TOKEN_MESSAGE);
    }
    const result = await sendStickerTelegram(to, fileId, {
      cfg,
      token,
      accountId: accountId ?? undefined,
      replyToMessageId: replyToMessageId ?? undefined,
      messageThreadId: messageThreadId ?? undefined,
      gatewayClientScopes: context.gatewayClientScopes,
    });
    context.notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
    });
  }

  if (action === "searchSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(STICKER_DISABLED_MESSAGE);
    }
    const query = readStringParam(params, "query", { required: true });
    const limit =
      readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      }) ?? 5;
    const results = await searchStickers(query, limit);
    return jsonResult({
      ok: true,
      count: results.length,
      stickers: results.map((s) => ({
        fileId: s.fileId,
        emoji: s.emoji,
        description: s.description,
        setName: s.setName,
      })),
    });
  }

  if (action === "stickerCacheStats") {
    const stats = await getCacheStats();
    return jsonResult({ ok: true, ...stats });
  }

  // `action` is `never` here: the caller's guard admits only handled names. `String()` keeps the
  // template legal, matching the dispatcher's own unreachable throw.
  throw new Error(`Unsupported Telegram native media action: ${String(action)}`);
}
