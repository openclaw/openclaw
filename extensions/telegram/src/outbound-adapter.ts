import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { markdownToTelegramHtmlChunks } from "./format.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { sendMessageTelegram } from "./send.js";
import { parseTelegramTarget } from "./targets.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;

type TelegramSendFn = typeof sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];

function resolveTelegramOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): {
  to: string;
  messageThreadId?: number;
} {
  const parsedTarget = parseTelegramTarget(params.to);
  return {
    to: parsedTarget.chatId,
    messageThreadId: parseTelegramThreadId(params.threadId) ?? parsedTarget.messageThreadId,
  };
}

function resolveTelegramSendContext(params: {
  to: string;
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  gatewayClientScopes?: readonly string[];
}): {
  send: TelegramSendFn;
  to: string;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
    gatewayClientScopes?: readonly string[];
  };
} {
  const send =
    resolveOutboundSendDep<TelegramSendFn>(params.deps, "telegram") ?? sendMessageTelegram;
  const target = resolveTelegramOutboundTarget({
    to: params.to,
    threadId: params.threadId,
  });
  return {
    send,
    to: target.to,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: target.messageThreadId,
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? undefined,
      gatewayClientScopes: params.gatewayClientScopes,
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
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      gatewayClientScopes,
    }) => {
      const { send, to: resolvedTo, baseOpts } = resolveTelegramSendContext({
        to,
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
      });
      return await send(resolvedTo, text, {
        ...baseOpts,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      forceDocument,
      gatewayClientScopes,
    }) => {
      const { send, to: resolvedTo, baseOpts } = resolveTelegramSendContext({
        to,
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
      });
      return await send(resolvedTo, text, {
        ...baseOpts,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        forceDocument: forceDocument ?? false,
      });
    },
  }),
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    replyToId,
    threadId,
    forceDocument,
    gatewayClientScopes,
  }) => {
    const { send, to: resolvedTo, baseOpts } = resolveTelegramSendContext({
      to,
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
      gatewayClientScopes,
    });
    const result = await sendTelegramPayloadMessages({
      send,
      to: resolvedTo,
      payload,
      baseOpts: {
        ...baseOpts,
        mediaLocalRoots,
        mediaReadFile,
        forceDocument: forceDocument ?? false,
      },
    });
    return attachChannelToResult("telegram", result);
  },
};
