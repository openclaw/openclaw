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
