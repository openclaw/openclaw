import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/channel-runtime";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { resolveOutboundSendDep, type OutboundSendDeps } from "openclaw/plugin-sdk/channel-runtime";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { markdownToTelegramHtmlChunks } from "./format.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { sendMessageTelegram } from "./send.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;

// ---------------------------------------------------------------------------
// Adaptive Card rendering: inline card extraction + Telegram HTML conversion.
// Mirrors src/cards/parse.ts + src/cards/strategies/telegram.ts but kept inline
// to avoid cross-workspace imports (extensions cannot import from src/ directly).
// ---------------------------------------------------------------------------

const AC_CARD_RE = /<!--adaptive-card-->([\s\S]*?)<!--\/adaptive-card-->/;

interface AcParsed {
  card: { type: "AdaptiveCard"; body: unknown[]; actions?: unknown[] };
  fallbackText: string;
}

function parseAdaptiveCardMarkers(text: string): AcParsed | null {
  const m = AC_CARD_RE.exec(text);
  if (!m) {
    return null;
  }
  try {
    const card = JSON.parse(m[1].trim());
    if (card?.type !== "AdaptiveCard") {
      return null;
    }
    const fallbackText = text.slice(0, m.index).trim();
    return { card, fallbackText };
  } catch {
    return null;
  }
}

type AcElement = Record<string, unknown>;

function acStr(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  return JSON.stringify(val);
}

function acEscapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTgTextBlock(el: AcElement): string {
  const escaped = acEscapeHtml(acStr(el.text));
  const weight = el.weight as string | undefined;
  const isSubtle = el.isSubtle === true;
  let line = escaped;
  if (weight === "Bolder") line = `<b>${line}</b>`;
  if (isSubtle) line = `<i>${line}</i>`;
  return line;
}

function renderTgFactSet(el: AcElement): string {
  const facts = el.facts as Array<{ title?: string; value?: string }> | undefined;
  if (!facts?.length) return "";
  return facts
    .map((f) => `<b>${acEscapeHtml(f.title ?? "")}</b>: ${acEscapeHtml(f.value ?? "")}`)
    .join("\n");
}

function renderTgElement(el: AcElement): string {
  switch (el.type) {
    case "TextBlock":
      return renderTgTextBlock(el);
    case "FactSet":
      return renderTgFactSet(el);
    case "ColumnSet": {
      const columns = el.columns as Array<{ items?: AcElement[] }> | undefined;
      if (!columns?.length) return "";
      return columns
        .flatMap((col) => (col.items ?? []).map(renderTgElement))
        .filter(Boolean)
        .join("\n");
    }
    case "Container": {
      const items = el.items as AcElement[] | undefined;
      return (items ?? []).map(renderTgElement).filter(Boolean).join("\n");
    }
    default:
      return "";
  }
}

type InlineButton = { text: string; url?: string; callback_data?: string };

function renderTgActions(actions: unknown[]): InlineButton[][] {
  const buttons: InlineButton[] = [];
  for (const raw of actions) {
    const action = raw as AcElement;
    const label = acStr(action.title);
    if (!label) continue;
    if (action.type === "Action.OpenUrl") {
      buttons.push({ text: label, url: acStr(action.url) });
    } else if (action.type === "Action.Submit") {
      const data = action.data != null ? JSON.stringify(action.data) : label;
      buttons.push({ text: label, callback_data: data.slice(0, 64) });
    }
  }
  return buttons.length > 0 ? buttons.map((b) => [b]) : [];
}

function renderTelegramCard(parsed: AcParsed): {
  text: string;
  replyMarkup?: { inline_keyboard: InlineButton[][] };
} {
  const lines: string[] = [];
  for (const el of parsed.card.body) {
    const rendered = renderTgElement(el as AcElement);
    if (rendered) lines.push(rendered);
  }
  const text = lines.join("\n\n") || acEscapeHtml(parsed.fallbackText);
  const keyboard = parsed.card.actions?.length ? renderTgActions(parsed.card.actions) : [];
  if (keyboard.length === 0) return { text };
  return { text, replyMarkup: { inline_keyboard: keyboard } };
}

type TelegramSendFn = typeof sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];

function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
}): {
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
  };
} {
  const send =
    resolveOutboundSendDep<TelegramSendFn>(params.deps, "telegram") ?? sendMessageTelegram;
  return {
    send,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? undefined,
    },
  };
}

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const telegramData = params.payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const text =
    resolveInteractiveTextFallback({
      text: params.payload.text,
      interactive: params.payload.interactive,
    }) ?? "";
  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    interactive: params.payload.interactive,
  });
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
  };

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await params.send(params.to, text, {
        ...payloadOpts,
        buttons,
      }),
    send: async ({ text, mediaUrl, isFirst }) =>
      await params.send(params.to, text, {
        ...payloadOpts,
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      }),
  });
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
  shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
  ...createAttachedChannelResultAdapter({
    channel: "telegram",
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId }) => {
      const { send, baseOpts } = resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
      });

      // Adaptive card rendering: convert card markers to Telegram HTML + inline keyboard
      const acParsed = parseAdaptiveCardMarkers(text);
      if (acParsed) {
        const rendered = renderTelegramCard(acParsed);
        const buttons: TelegramInlineButtons | undefined = rendered.replyMarkup
          ? (rendered.replyMarkup.inline_keyboard as unknown as TelegramInlineButtons)
          : undefined;
        return await send(to, rendered.text, {
          ...baseOpts,
          buttons,
        });
      }

      return await send(to, text, {
        ...baseOpts,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      threadId,
      forceDocument,
    }) => {
      const { send, baseOpts } = resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
      });
      return await send(to, text, {
        ...baseOpts,
        mediaUrl,
        mediaLocalRoots,
        forceDocument: forceDocument ?? false,
      });
    },
  }),
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    threadId,
    forceDocument,
  }) => {
    const { send, baseOpts } = resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
    });
    const result = await sendTelegramPayloadMessages({
      send,
      to,
      payload,
      baseOpts: {
        ...baseOpts,
        mediaLocalRoots,
        forceDocument: forceDocument ?? false,
      },
    });
    return attachChannelToResult("telegram", result);
  },
};
