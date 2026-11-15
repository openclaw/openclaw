import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isTelegramMessageNotModifiedError } from "../network-errors.js";
import { withTelegramApiContext } from "../send-context.js";
import type { TelegramSendResult } from "../send-message-types.js";
import { finalizeTelegramOutbound, prepareTelegramOutbound } from "../send-outbound.js";
import { resolveTelegramBotUserIdFromToken } from "../token-fingerprint.js";
import {
  TELEGRAM_WIDGET_CAPTION_MAX_CHARS,
  telegramWidgetApi,
  type TelegramSendWidgetParams,
} from "./widget-bot-api.js";
import { recordTelegramSentWidget } from "./widget-store.js";

export function hashTelegramWidgetSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export async function sendTelegramWidget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  to: string;
  source: string;
  title: string;
  name: string;
  state?: string;
}): Promise<TelegramSendResult> {
  return withTelegramApiContext(params, async (context) => {
    const prepared = await prepareTelegramOutbound({
      to: params.to,
      context,
      opts: {},
      thread: {},
    });
    const caption = Array.from(params.title).slice(0, TELEGRAM_WIDGET_CAPTION_MAX_CHARS).join("");
    const request: TelegramSendWidgetParams = {
      chat_id: prepared.chatId,
      html: params.source,
      caption,
      // Every widget may query; the query router decides which taps reach the agent.
      allow_queries: true,
      ...(params.state ? { chat_data: params.state } : {}),
      ...prepared.threadParams,
    };
    const botUserId = resolveTelegramBotUserIdFromToken(context.account.token);
    const result = await prepared.request(
      () => telegramWidgetApi(context.api).sendWidget(request),
      "widget",
    );
    const sent = await finalizeTelegramOutbound({
      context,
      prepared,
      result,
      resultContext: "widget send",
      ...(botUserId !== undefined ? { botUserId } : {}),
      text: caption,
    });
    await recordTelegramSentWidget({
      accountId: context.account.accountId,
      chatId: prepared.chatId,
      messageId: result.message_id,
      widget: {
        name: params.name,
        sourceHash: hashTelegramWidgetSource(params.source),
        title: caption,
        source: params.source,
        ...(prepared.threadSpec?.scope === "dm" && prepared.threadSpec.id !== undefined
          ? { messageThreadId: prepared.threadSpec.id }
          : {}),
        ...(params.state ? { state: params.state } : {}),
      },
    });
    return sent;
  });
}

export async function editTelegramWidgetState(params: {
  cfg: OpenClawConfig;
  accountId: string;
  chatId: string;
  messageId: number;
  state: string;
}): Promise<void> {
  await withTelegramApiContext(params, async (context) => {
    try {
      // An empty string clears the state; Telegram leaves edits silent (no "edited" mark).
      await telegramWidgetApi(context.api).editMessageWidgetData({
        chat_id: params.chatId,
        message_id: params.messageId,
        chat_data: params.state,
      });
    } catch (error) {
      if (!isTelegramMessageNotModifiedError(error)) {
        throw error;
      }
    }
  });
}
