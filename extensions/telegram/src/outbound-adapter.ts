import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveOutboundSendDep,
  sanitizeForPlainText,
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
import { pinMessageTelegram, reactMessageTelegram } from "./send.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];

let telegramSendModulePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendModule() {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  gatewayClientScopes?: readonly string[];
}): Promise<{
  send: TelegramSendFn;
  react: typeof reactMessageTelegram;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
    gatewayClientScopes?: readonly string[];
  };
}> {
  const send =
    resolveOutboundSendDep<TelegramSendFn>(params.deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram;
  return {
    send,
    react: reactMessageTelegram,
    baseOpts: {
      verbose: false,
      textMode: "html",
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      accountId: params.accountId ?? undefined,
      gatewayClientScopes: params.gatewayClientScopes,
    },
  };
}

function resolveTelegramReactionEmoji(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.emoji === "string") {
    const trimmed = value.emoji.trim();
    return trimmed || undefined;
  }
  return undefined;
}

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  react?: typeof reactMessageTelegram;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const telegramData = params.payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string; reaction?: string | { emoji?: string } }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const reactionEmoji = resolveTelegramReactionEmoji(telegramData?.reaction);
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

  if (reactionEmoji && params.react && payloadOpts.replyToMessageId != null) {
    await params.react(params.to, payloadOpts.replyToMessageId, reactionEmoji, {
      cfg: payloadOpts.cfg,
      accountId: payloadOpts.accountId,
      gatewayClientScopes: payloadOpts.gatewayClientScopes,
      verbose: payloadOpts.verbose,
    }).catch(() => {});
  }

  if (!text && mediaUrls.length === 0) {
    return {
      messageId:
        payloadOpts.replyToMessageId != null ? String(payloadOpts.replyToMessageId) : "reaction-only",
      chatId: params.to,
    };
  }

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
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: false,
  },
  deliveryCapabilities: {
    pin: true,
  },
  renderPresentation: ({ payload, presentation }) => ({
    ...payload,
    text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
    interactive: presentationToInteractiveReply(presentation),
  }),
  pinDeliveredMessage: async ({ cfg, target, messageId, pin }) => {
    await pinMessageTelegram(target.to, messageId, {
      cfg,
      accountId: target.accountId ?? undefined,
      notify: pin.notify,
      verbose: false,
    });
  },
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
      const { send, baseOpts } = await resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
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
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      forceDocument,
      gatewayClientScopes,
    }) => {
      const { send, baseOpts } = await resolveTelegramSendContext({
        cfg,
        deps,
        accountId,
        replyToId,
        threadId,
        gatewayClientScopes,
      });
      return await send(to, text, {
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
    const { send, react, baseOpts } = await resolveTelegramSendContext({
      cfg,
      deps,
      accountId,
      replyToId,
      threadId,
      gatewayClientScopes,
    });
    const result = await sendTelegramPayloadMessages({
      send,
      react,
      to,
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
