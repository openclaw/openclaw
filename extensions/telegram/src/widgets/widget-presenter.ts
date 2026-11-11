import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveTelegramAccount } from "../accounts.js";
import { parseTelegramTarget } from "../targets.js";
import {
  measureTelegramWidgetHtml,
  TELEGRAM_WIDGET_DATA_MAX_BYTES,
  TELEGRAM_WIDGET_HTML_MAX_BYTES,
  TELEGRAM_WIDGET_HTML_MAX_COMPRESSED_BYTES,
} from "./widget-bot-api.js";
import { checkTelegramWidget, formatTelegramWidgetCheckErrors } from "./widget-check.js";
import {
  TELEGRAM_WIDGET_AUTHORING_GUIDANCE,
  TELEGRAM_WIDGET_STATE_DESCRIPTION,
} from "./widget-guidance.js";
import {
  editTelegramWidgetState,
  hashTelegramWidgetSource,
  sendTelegramWidget,
} from "./widget-send.js";
import {
  lookupTelegramSentWidget,
  lookupTelegramWidgetTap,
  recordTelegramSentWidget,
} from "./widget-store.js";

type WidgetPresenter = Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0];
type WidgetPresenterContext = Parameters<WidgetPresenter["availability"]>[0];
type WidgetPresentResult = Awaited<ReturnType<WidgetPresenter["present"]>>;

type TelegramWidgetRoute = {
  cfg: OpenClawConfig;
  accountId: string;
  to: string;
  chatId: string;
  messageThreadId?: number;
};

const unavailable = (message: string) => ({
  ok: false as const,
  error: { code: "unavailable" as const, message },
});
const presentationError = (message: string) => ({
  ok: false as const,
  error: { code: "presentation_error" as const, message },
});

// Production Telegram delivers widgets only in private chats with the bot.
function resolveTelegramWidgetRoute(
  context: WidgetPresenterContext,
  cfg: OpenClawConfig,
): TelegramWidgetRoute | undefined {
  if (context.messageChannel !== "telegram") {
    return undefined;
  }
  const to =
    context.currentMessagingTarget?.trim() ||
    context.currentChannelId?.trim() ||
    context.deliveryContext?.to?.trim();
  if (!to) {
    return undefined;
  }
  const target = parseTelegramTarget(to);
  if (target.chatType !== "direct" || target.directMessagesTopicId !== undefined) {
    return undefined;
  }
  const account = resolveTelegramAccount({
    cfg,
    accountId: context.accountId ?? context.deliveryContext?.accountId,
  });
  if (!account.enabled || account.tokenStatus !== "available") {
    return undefined;
  }
  const threadId = context.deliveryContext?.threadId;
  const messageThreadId =
    target.messageThreadId ?? (typeof threadId === "number" ? threadId : undefined);
  return {
    cfg,
    accountId: account.accountId,
    to,
    chatId: target.chatId,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
  };
}

function widgetReceipt(messageId: number | string) {
  const id = String(messageId);
  return {
    primaryPlatformMessageId: id,
    platformMessageIds: [id],
    parts: [{ platformMessageId: id, kind: "card" as const, index: 0 }],
    sentAt: Date.now(),
  };
}

async function presentTelegramWidget(
  route: TelegramWidgetRoute,
  params: Parameters<WidgetPresenter["present"]>[0],
): Promise<WidgetPresentResult> {
  const source = params.document.source;
  const tap = params.context.currentMessageId
    ? await lookupTelegramWidgetTap({
        accountId: route.accountId,
        queryId: params.context.currentMessageId,
      })
    : undefined;
  const tapped =
    tap?.chatId === route.chatId
      ? await lookupTelegramSentWidget({
          accountId: route.accountId,
          chatId: tap.chatId,
          messageId: tap.messageId,
        })
      : undefined;
  // A tap turn updates the tapped widget while its code is unchanged; anything else is a new message.
  // The tap names its widget; models often re-derive a different name, so only the code must match.
  const updatesTapped =
    tap && tapped && (!source || tapped.sourceHash === hashTelegramWidgetSource(source));
  if (updatesTapped) {
    // Replay the widget's own code with its old state, then deliver the new one.
    const code = source || tapped.source;
    const problems = code
      ? await checkTelegramWidget({
          source: code,
          // Telegram exposes an empty or missing state to widget code as null.
          state: tapped.state || null,
          nextState: params.state || null,
          tapAll: false,
        })
      : [];
    if (problems.length) {
      return presentationError(formatTelegramWidgetCheckErrors(problems));
    }
    await editTelegramWidgetState({
      cfg: route.cfg,
      accountId: route.accountId,
      chatId: tap.chatId,
      messageId: tap.messageId,
      state: params.state ?? "",
    });
    await recordTelegramSentWidget({
      accountId: route.accountId,
      chatId: tap.chatId,
      messageId: tap.messageId,
      widget: { ...tapped, ...(params.state ? { state: params.state } : { state: undefined }) },
    });
    return {
      ok: true,
      value: { kind: "message", receipt: widgetReceipt(tap.messageId), updated: true },
    };
  }
  if (!source) {
    return presentationError(
      tap
        ? "The tapped widget is no longer known; send widget_code for a new widget"
        : "A state-only update applies only while answering a widget_request; send widget_code for a new widget",
    );
  }
  const size = measureTelegramWidgetHtml(source);
  if (
    size.bytes > TELEGRAM_WIDGET_HTML_MAX_BYTES ||
    size.compressedBytes > TELEGRAM_WIDGET_HTML_MAX_COMPRESSED_BYTES
  ) {
    return presentationError(
      `widget_code is ${size.bytes} bytes (${size.compressedBytes} compressed); Telegram allows ${TELEGRAM_WIDGET_HTML_MAX_BYTES} bytes and ${TELEGRAM_WIDGET_HTML_MAX_COMPRESSED_BYTES} compressed. Shorten it and retry`,
    );
  }
  const problems = await checkTelegramWidget({
    source,
    state: params.state || null,
    tapAll: true,
  });
  if (problems.length) {
    return presentationError(formatTelegramWidgetCheckErrors(problems));
  }
  const sent = await sendTelegramWidget({
    cfg: route.cfg,
    accountId: route.accountId,
    to: route.to,
    ...(route.messageThreadId !== undefined ? { messageThreadId: route.messageThreadId } : {}),
    source,
    title: params.title,
    name: params.name,
    ...(params.state !== undefined ? { state: params.state } : {}),
  });
  // The widget is already visible here; a missing receipt must not invite a duplicate send.
  return {
    ok: true,
    value: { kind: "message", receipt: sent.receipt ?? widgetReceipt(sent.messageId) },
  };
}

export function registerTelegramWidgetPresenter(api: OpenClawPluginApi): void {
  const currentConfig = () => api.runtime.config.current() as OpenClawConfig;
  api.registerWidgetPresenter({
    target: "current_channel",
    description: "Send a Telegram message widget in the current private chat",
    capabilities: {
      sourceKinds: ["html"],
      maxSourceBytes: TELEGRAM_WIDGET_HTML_MAX_BYTES,
      authoringGuidance: TELEGRAM_WIDGET_AUTHORING_GUIDANCE,
      state: {
        maxBytes: TELEGRAM_WIDGET_DATA_MAX_BYTES,
        description: TELEGRAM_WIDGET_STATE_DESCRIPTION,
      },
    },
    match: (context) => resolveTelegramWidgetRoute(context, currentConfig()) !== undefined,
    async availability(context) {
      return resolveTelegramWidgetRoute(context, currentConfig())
        ? { ok: true, value: { available: true } }
        : unavailable("Telegram widgets are available only in private chats with the bot.");
    },
    async present(params) {
      const route = resolveTelegramWidgetRoute(params.context, currentConfig());
      if (!route) {
        return unavailable("Telegram widgets are available only in private chats with the bot.");
      }
      try {
        return await presentTelegramWidget(route, params);
      } catch (error) {
        return presentationError(`Telegram widget delivery failed: ${formatErrorMessage(error)}`);
      }
    },
  });
}
