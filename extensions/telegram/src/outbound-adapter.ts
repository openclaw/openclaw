// Telegram plugin module implements outbound adapter behavior.
import type { OutboundDeliveryFormattingOptions } from "openclaw/plugin-sdk/channel-outbound";
import {
  resolveOutboundSendDep,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { markTelegramDeliveryErrorVisible } from "./delivery-error.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";
import { splitTelegramRichTextChunks, TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";
import { normalizeTelegramOutboundTarget, parseTelegramTarget } from "./targets.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = TELEGRAM_RICH_TEXT_LIMIT;
export const TELEGRAM_POLL_OPTION_LIMIT = 10;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendModule = typeof import("./send.js");
type TelegramSendOpts = Parameters<TelegramSendFn>[2];
type ResolveTelegramSendFn = (deps?: OutboundSendDeps) => Promise<TelegramSendFn>;
type LoadTelegramSendModuleFn = () => Promise<TelegramSendModule>;

let telegramSendModulePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendModule(): Promise<TelegramSendModule> {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}

async function resolveDefaultTelegramSend(deps?: OutboundSendDeps): Promise<TelegramSendFn> {
  return (
    resolveOutboundSendDep<TelegramSendFn>(deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram
  );
}

function chunkTelegramOutboundText(
  text: string,
  limit: number,
  ctx?: { formatting?: OutboundDeliveryFormattingOptions },
): string[] {
  return splitTelegramRichTextChunks({
    text,
    textLimit: limit,
    textMode: ctx?.formatting?.parseMode === "HTML" ? "html" : "markdown",
    chunkMode: ctx?.formatting?.chunkMode ?? "length",
  });
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  replyToMode?: TelegramSendOpts["replyToMode"];
  replyToIdSource?: TelegramSendOpts["replyToIdSource"];
  threadId?: string | number | null;
  formatting?: OutboundDeliveryFormattingOptions;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
  resolveSend: ResolveTelegramSendFn;
}): Promise<{
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode?: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    replyToMode?: TelegramSendOpts["replyToMode"];
    replyToIdSource?: TelegramSendOpts["replyToIdSource"];
    accountId?: string;
    silent?: boolean;
    gatewayClientScopes?: readonly string[];
  };
}> {
  const send = await params.resolveSend(params.deps);
  return {
    send,
    baseOpts: {
      verbose: false,
      cfg: params.cfg,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      ...(params.replyToMode ? { replyToMode: params.replyToMode } : {}),
      ...(params.replyToIdSource ? { replyToIdSource: params.replyToIdSource } : {}),
      accountId: params.accountId ?? undefined,
      silent: params.silent,
      gatewayClientScopes: params.gatewayClientScopes,
      ...(params.formatting?.parseMode === "HTML" ? { textMode: "html" as const } : {}),
    },
  };
}

async function resolveTelegramOutboundSendContext(
  params: Parameters<typeof resolveTelegramSendContext>[0] & { to: string },
) {
  const outboundTo = normalizeTelegramOutboundTarget(params.to);
  const { send, baseOpts } = await resolveTelegramSendContext(params);
  return { outboundTo, send, baseOpts };
}

export type CreateTelegramOutboundAdapterOptions = {
  resolveSend?: ResolveTelegramSendFn;
  loadSendModule?: LoadTelegramSendModuleFn;
  beforeDeliverPayload?: ChannelOutboundAdapter["beforeDeliverPayload"];
  shouldSuppressLocalPayloadPrompt?: ChannelOutboundAdapter["shouldSuppressLocalPayloadPrompt"];
  shouldTreatDeliveredTextAsVisible?: ChannelOutboundAdapter["shouldTreatDeliveredTextAsVisible"];
  targetsMatchForReplySuppression?: ChannelOutboundAdapter["targetsMatchForReplySuppression"];
  preferFinalAssistantVisibleText?: boolean;
};

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const telegramData = params.payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string; standardMessage?: boolean }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  const text =
    resolveTelegramInteractiveTextFallback({
      text: params.payload.text,
      interactive: params.payload.interactive,
      presentation,
    }) ?? "";
  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation,
    interactive: params.payload.interactive,
  });
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
    standardMessage: telegramData?.standardMessage === true,
    ...(params.payload.audioAsVoice === true ? { asVoice: true } : {}),
  };
  const singleUseImplicitReply =
    payloadOpts.standardMessage &&
    payloadOpts.replyToMessageId != null &&
    payloadOpts.replyToIdSource !== "explicit" &&
    payloadOpts.replyToMode != null &&
    isSingleUseReplyToMode(payloadOpts.replyToMode);
  let implicitReplyAvailable = true;
  let deliveredSendCount = 0;
  const sendWithReplyFanout = async (textLocal: string, options: TelegramSendOpts) => {
    const effectiveOptions =
      singleUseImplicitReply && !implicitReplyAvailable
        ? { ...options, replyToMessageId: undefined }
        : options;
    let result: Awaited<ReturnType<TelegramSendFn>>;
    try {
      result = await params.send(params.to, textLocal, effectiveOptions);
    } catch (error) {
      if (deliveredSendCount > 0) {
        throw markTelegramDeliveryErrorVisible(error);
      }
      throw error;
    }
    deliveredSendCount += 1;
    if (singleUseImplicitReply && effectiveOptions.replyToMessageId != null) {
      implicitReplyAvailable = false;
    }
    return result;
  };

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    text,
    mediaUrls,
    fallbackResult: { messageId: "unknown", chatId: params.to },
    sendNoMedia: async () =>
      await sendWithReplyFanout(text, {
        ...payloadOpts,
        buttons,
      }),
    send: async ({ text: textLocal, mediaUrl, isFirst }) =>
      await sendWithReplyFanout(textLocal, {
        ...payloadOpts,
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      }),
  });
}

export function createTelegramOutboundAdapter(
  options: CreateTelegramOutboundAdapterOptions = {},
): ChannelOutboundAdapter {
  const resolveSend = options.resolveSend ?? resolveDefaultTelegramSend;
  const loadSendModule = options.loadSendModule ?? loadTelegramSendModule;

  return {
    deliveryMode: "direct",
    chunker: chunkTelegramOutboundText,
    chunkerMode: "markdown",
    extractMarkdownImages: true,
    textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
    shouldSuppressLocalPayloadPrompt: options.shouldSuppressLocalPayloadPrompt,
    beforeDeliverPayload: options.beforeDeliverPayload,
    shouldTreatDeliveredTextAsVisible: options.shouldTreatDeliveredTextAsVisible,
    targetsMatchForReplySuppression: options.targetsMatchForReplySuppression,
    preferFinalAssistantVisibleText: options.preferFinalAssistantVisibleText,
    presentationCapabilities: {
      supported: true,
      buttons: true,
      selects: true,
      context: true,
      divider: false,
      limits: {
        actions: {
          maxActions: 100,
          maxActionsPerRow: 3,
          maxLabelLength: 64,
          supportsStyles: false,
        },
        selects: {
          maxOptions: 100,
          maxLabelLength: 64,
        },
        text: {
          markdownDialect: "markdown",
        },
      },
    },
    deliveryCapabilities: {
      pin: true,
      durableFinal: {
        text: true,
        media: true,
        payload: true,
        silent: true,
        replyTo: true,
        thread: true,
        nativeQuote: false,
        messageSendingHooks: true,
        batch: true,
      },
    },
    renderPresentation: ({ payload, presentation }) => {
      const telegramData = payload.channelData?.telegram as Record<string, unknown> | undefined;
      const hasExplicitButtons = (telegramData && "buttons" in telegramData) || payload.interactive;
      const buttons = hasExplicitButtons
        ? undefined
        : resolveTelegramInlineButtons({ presentation });
      return {
        ...payload,
        text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
        channelData: {
          ...payload.channelData,
          telegram: {
            ...telegramData,
            ...(buttons ? { buttons } : {}),
          },
        },
      };
    },
    pinDeliveredMessage: async ({ cfg, target, messageId, pin, gatewayClientScopes }) => {
      const { pinMessageTelegram } = await loadSendModule();
      const outboundTo = normalizeTelegramOutboundTarget(target.to);
      const pinTarget = parseTelegramTarget(outboundTo);
      await pinMessageTelegram(pinTarget.chatId, messageId, {
        cfg,
        accountId: target.accountId ?? undefined,
        notify: pin.notify,
        verbose: false,
        gatewayClientScopes,
      });
    },
    resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
      typeof fallbackLimit === "number"
        ? Math.min(fallbackLimit, TELEGRAM_RICH_TEXT_LIMIT)
        : TELEGRAM_RICH_TEXT_LIMIT,
    pollMaxOptions: TELEGRAM_POLL_OPTION_LIMIT,
    supportsPollDurationSeconds: true,
    supportsAnonymousPolls: true,
    ...createAttachedChannelResultAdapter({
      channel: "telegram",
      sendText: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return await send(outboundTo, params.text, {
          ...baseOpts,
        });
      },
      sendMedia: async (params) => {
        const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
          ...params,
          resolveSend,
        });
        return await send(outboundTo, params.text, {
          ...baseOpts,
          mediaUrl: params.mediaUrl,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          forceDocument: params.forceDocument ?? false,
        });
      },
    }),
    sendPayload: async (params) => {
      const { outboundTo, send, baseOpts } = await resolveTelegramOutboundSendContext({
        ...params,
        resolveSend,
      });
      const result = await sendTelegramPayloadMessages({
        send,
        to: outboundTo,
        payload: params.payload,
        baseOpts: {
          ...baseOpts,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          forceDocument: params.forceDocument ?? false,
        },
      });
      return attachChannelToResult("telegram", result);
    },
    sendPoll: async ({
      cfg,
      to,
      poll,
      accountId,
      threadId,
      silent,
      isAnonymous,
      gatewayClientScopes,
    }) => {
      const outboundTo = normalizeTelegramOutboundTarget(to);
      const { sendPollTelegram } = await loadSendModule();
      return await sendPollTelegram(outboundTo, poll, {
        cfg,
        accountId: accountId ?? undefined,
        messageThreadId: parseTelegramThreadId(threadId),
        silent: silent ?? undefined,
        isAnonymous: isAnonymous ?? undefined,
        gatewayClientScopes,
      });
    },
  };
}

export const telegramOutbound: ChannelOutboundAdapter = createTelegramOutboundAdapter();
