// Telegram plugin module implements native media action behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  jsonResult,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { createTelegramActionGate } from "./accounts.js";
import {
  readTelegramPositiveIntegerParam,
  readTelegramReplyToMessageId,
  readTelegramThreadId,
} from "./action-params.js";
import { sendDiceTelegram, sendStickerTelegram } from "./send.js";
import { getCacheStats, searchStickers } from "./sticker-cache.js";
import { resolveTelegramToken } from "./token.js";

/** The dispatcher narrows on this list, so its trailing throw keeps seeing an exhausted union. */
const TELEGRAM_NATIVE_MEDIA_ACTIONS = [
  "searchSticker",
  "sendDice",
  "sendSticker",
  "stickerCacheStats",
] as const;

export type TelegramNativeMediaActionName = (typeof TELEGRAM_NATIVE_MEDIA_ACTIONS)[number];

export function isTelegramNativeMediaAction(
  action: string,
): action is TelegramNativeMediaActionName {
  return TELEGRAM_NATIVE_MEDIA_ACTIONS.some((owned) => owned === action);
}

export type TelegramNativeMediaActionContext = {
  action: TelegramNativeMediaActionName;
  params: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string;
  gatewayClientScopes?: readonly string[];
  isActionEnabled: ReturnType<typeof createTelegramActionGate>;
  notifyVisibleOutboundSuccess: (to: string, messageThreadId?: number | null) => void;
  /** Host-owned send authority: recorded and revalidated at the dispatch boundary. */
  onPlatformSendDispatch?: ChannelMessageActionContext["onPlatformSendDispatch"];
  assertDirectAdapterHandoff?: ChannelMessageActionContext["assertDirectAdapterHandoff"];
};

/**
 * Dice and stickers carry no text body, so they bypass the text send pipeline and are handled here
 * together with the sticker cache queries that serve them.
 */
export async function handleTelegramNativeMediaAction(
  context: TelegramNativeMediaActionContext,
): Promise<AgentToolResult<unknown>> {
  const { action, params, cfg, accountId, isActionEnabled } = context;

  if (action === "sendDice" && !isActionEnabled("sendMessage")) {
    throw new Error("Telegram sendMessage is disabled.");
  }
  if (
    (action === "sendSticker" || action === "searchSticker") &&
    !isActionEnabled("sticker", false)
  ) {
    throw new Error(
      "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
    );
  }

  if (action === "sendDice" || action === "sendSticker") {
    const to =
      readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
    const messageThreadId = readTelegramThreadId(params);
    const token = resolveTelegramToken(cfg, { accountId }).token;
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const sendOpts = {
      cfg,
      token,
      accountId,
      replyToMessageId: readTelegramReplyToMessageId(params),
      messageThreadId,
      gatewayClientScopes: context.gatewayClientScopes,
      // Passing this callback is what binds authority to every request in withTelegramApiContext.
      assertPlatformSendAuthorized: context.assertDirectAdapterHandoff,
    };
    if (action === "sendSticker") {
      const fileId =
        readStringParam(params, "fileId") ?? readStringArrayParam(params, "stickerId")?.[0];
      if (!fileId) {
        throw new Error("fileId is required.");
      }
      const sticker = await sendStickerTelegram(to, fileId, sendOpts);
      context.notifyVisibleOutboundSuccess(to, messageThreadId);
      return jsonResult({ ok: true, messageId: sticker.messageId, chatId: sticker.chatId });
    }
    const result = await sendDiceTelegram(to, readStringParam(params, "diceEmoji"), {
      ...sendOpts,
      silent: readBooleanParam(params, "silent"),
      onPlatformSendDispatch: context.onPlatformSendDispatch,
    });
    context.notifyVisibleOutboundSuccess(to, messageThreadId);
    return jsonResult({
      ok: true,
      messageId: result.messageId,
      chatId: result.chatId,
      emoji: result.emoji,
      value: result.value,
      // The receipt's thread is what matches a topic-addressed roll to its source conversation.
      ...(result.receipt
        ? { receipt: { threadId: result.receipt.threadId, replyToId: result.receipt.replyToId } }
        : {}),
    });
  }

  if (action === "searchSticker") {
    const query = readStringParam(params, "query", { required: true });
    const limit = readTelegramPositiveIntegerParam(params, "limit") ?? 5;
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

  // `action` is `never` here; `String()` keeps the template legal, as in the dispatcher's own throw.
  throw new Error(`Unsupported Telegram native media action: ${String(action)}`);
}
