// Line plugin module implements auto reply delivery behavior.
import type { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { FlexContainer } from "./flex-templates.js";
import type { ProcessedLineMessage } from "./markdown-to-line.js";
import {
  buildLineReplyMediaMessage,
  hasLineSpecificMediaOptions,
  type ResolveLineOutboundMediaOpts,
} from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import type { SendLineReplyChunksParams } from "./reply-chunks.js";
import type { LineChannelDataWithMedia, LineTemplateMessagePayload } from "./types.js";

type LineAutoReplyDeps = {
  buildTemplateMessageFromPayload: (
    payload: LineTemplateMessagePayload,
  ) => messagingApi.TemplateMessage | null;
  processLineMessage: (text: string) => ProcessedLineMessage;
  chunkMarkdownText: (text: string, limit: number) => string[];
  sendLineReplyChunks: (params: SendLineReplyChunksParams) => Promise<{ replyTokenUsed: boolean }>;
  createQuickReplyItems: (labels: string[]) => messagingApi.QuickReply;
  pushMessagesLine: (
    to: string,
    messages: messagingApi.Message[],
    opts: { cfg: OpenClawConfig; accountId?: string },
  ) => Promise<unknown>;
  createFlexMessage: (altText: string, contents: FlexContainer) => messagingApi.FlexMessage;
  createImageMessage: (
    originalContentUrl: string,
    previewImageUrl?: string,
  ) => messagingApi.ImageMessage;
  createLocationMessage: (location: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  }) => messagingApi.LocationMessage;
} & Pick<
  SendLineReplyChunksParams,
  | "replyMessageLine"
  | "pushMessageLine"
  | "pushTextMessageWithQuickReplies"
  | "createTextMessageWithQuickReplies"
  | "onReplyError"
>;

type LineAutoReplyDeliveryResult =
  | { status: "delivered"; replyTokenUsed: boolean }
  | { status: "partial"; replyTokenUsed: boolean; error: Error };

function markLineVisibleDeliveryError(error: unknown): Error {
  if (error instanceof Error && Object.isExtensible(error)) {
    Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
    return error;
  }
  const visibleError = new Error("LINE rich or media message send failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

export async function deliverLineAutoReply(params: {
  payload: ReplyPayload;
  lineData: LineChannelDataWithMedia;
  to: string;
  replyToken?: string | null;
  replyTokenUsed: boolean;
  accountId?: string;
  cfg: OpenClawConfig;
  textLimit: number;
  deps: LineAutoReplyDeps;
}): Promise<LineAutoReplyDeliveryResult> {
  const { payload, lineData, replyToken, accountId, to, textLimit, deps } = params;
  let replyTokenUsed = params.replyTokenUsed;

  const pushLineMessages = async (messages: messagingApi.Message[]): Promise<void> => {
    if (messages.length === 0) {
      return;
    }
    for (let i = 0; i < messages.length; i += 5) {
      await deps.pushMessagesLine(to, messages.slice(i, i + 5), {
        cfg: params.cfg,
        accountId,
      });
    }
  };

  const sendLineMessages = async (
    messages: messagingApi.Message[],
    allowReplyToken: boolean,
  ): Promise<void> => {
    if (messages.length === 0) {
      return;
    }

    let remaining = messages;
    if (allowReplyToken && replyToken && !replyTokenUsed) {
      const replyBatch = remaining.slice(0, 5);
      try {
        await deps.replyMessageLine(replyToken, replyBatch, {
          cfg: params.cfg,
          accountId,
        });
      } catch (err) {
        deps.onReplyError?.(err);
        await pushLineMessages(replyBatch);
      }
      replyTokenUsed = true;
      remaining = remaining.slice(replyBatch.length);
    }

    if (remaining.length > 0) {
      await pushLineMessages(remaining);
    }
  };

  const richMessages: messagingApi.Message[] = [];
  const hasQuickReplies = Boolean(lineData.quickReplies?.length);

  if (lineData.flexMessage) {
    richMessages.push(
      deps.createFlexMessage(
        truncateUtf16Safe(lineData.flexMessage.altText, 400),
        lineData.flexMessage.contents as FlexContainer,
      ),
    );
  }

  if (lineData.templateMessage) {
    const templateMsg = deps.buildTemplateMessageFromPayload(lineData.templateMessage);
    if (templateMsg) {
      richMessages.push(templateMsg);
    }
  }

  if (lineData.location) {
    richMessages.push(deps.createLocationMessage(lineData.location));
  }

  const processed = payload.text
    ? deps.processLineMessage(payload.text)
    : { text: "", flexMessages: [] };

  for (const flexMsg of processed.flexMessages) {
    richMessages.push(
      deps.createFlexMessage(truncateUtf16Safe(flexMsg.altText, 400), flexMsg.contents),
    );
  }

  const chunks = processed.text ? deps.chunkMarkdownText(processed.text, textLimit) : [];

  // Match the push path (outbound.ts): honor channelData.line.mediaKind and the
  // other LINE media options so a reply-token video/audio is not silently
  // downgraded to an image. Generic media sends without LINE-specific options
  // keep the image route. A media that cannot be built (e.g. a video missing its
  // preview image) surfaces as a visible partial delivery instead of dropping.
  const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
  const useLineSpecificMedia = hasLineSpecificMediaOptions(lineData);
  const mediaOpts: ResolveLineOutboundMediaOpts = {
    mediaKind: lineData.mediaKind,
    previewImageUrl: lineData.previewImageUrl,
    durationMs: lineData.durationMs,
    trackingId: lineData.trackingId,
  };
  const mediaMessages: messagingApi.Message[] = [];
  let richMediaError: unknown;
  for (const rawUrl of mediaUrls) {
    const url = rawUrl?.trim();
    if (!url) {
      continue;
    }
    if (!useLineSpecificMedia) {
      mediaMessages.push(deps.createImageMessage(url));
      continue;
    }
    try {
      mediaMessages.push(await buildLineReplyMediaMessage(url, mediaOpts, to));
    } catch (err) {
      richMediaError ??= err;
    }
  }

  if (chunks.length > 0) {
    const hasRichOrMedia = richMessages.length > 0 || mediaMessages.length > 0;
    // Quick replies attach to the trailing message, so when both are present the
    // rich/media bubbles must go out before the quick-reply text. Capture a
    // failure instead of swallowing it: the text still sends below, but a lost
    // rich/media bubble must surface as a partial delivery, not silent success.
    const sendRichBeforeText = hasQuickReplies && hasRichOrMedia;
    if (sendRichBeforeText) {
      try {
        await sendLineMessages([...richMessages, ...mediaMessages], false);
      } catch (err) {
        richMediaError ??= err;
      }
    }
    const { replyTokenUsed: nextReplyTokenUsed } = await deps.sendLineReplyChunks({
      to,
      chunks,
      quickReplies: lineData.quickReplies,
      replyToken,
      replyTokenUsed,
      cfg: params.cfg,
      accountId,
      replyMessageLine: deps.replyMessageLine,
      pushMessageLine: deps.pushMessageLine,
      pushTextMessageWithQuickReplies: deps.pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies: deps.createTextMessageWithQuickReplies,
    });
    replyTokenUsed = nextReplyTokenUsed;
    if (!sendRichBeforeText) {
      try {
        await sendLineMessages(richMessages, false);
        if (mediaMessages.length > 0) {
          await sendLineMessages(mediaMessages, false);
        }
      } catch (err) {
        richMediaError ??= err;
      }
    }
  } else {
    const combined = [...richMessages, ...mediaMessages];
    if (hasQuickReplies && combined.length === 0) {
      const { replyTokenUsed: nextReplyTokenUsed } = await deps.sendLineReplyChunks({
        to,
        chunks: [buildLineQuickReplyFallbackText(lineData.quickReplies)],
        quickReplies: lineData.quickReplies,
        replyToken,
        replyTokenUsed,
        cfg: params.cfg,
        accountId,
        replyMessageLine: deps.replyMessageLine,
        pushMessageLine: deps.pushMessageLine,
        pushTextMessageWithQuickReplies: deps.pushTextMessageWithQuickReplies,
        createTextMessageWithQuickReplies: deps.createTextMessageWithQuickReplies,
        onReplyError: deps.onReplyError,
      });
      replyTokenUsed = nextReplyTokenUsed;
    } else {
      if (hasQuickReplies && combined.length > 0) {
        const quickReply = deps.createQuickReplyItems(lineData.quickReplies!);
        const targetIndex =
          replyToken && !replyTokenUsed ? Math.min(4, combined.length - 1) : combined.length - 1;
        const target = combined[targetIndex] as messagingApi.Message & {
          quickReply?: messagingApi.QuickReply;
        };
        combined[targetIndex] = { ...target, quickReply };
      }
      await sendLineMessages(combined, true);
    }
  }

  if (richMediaError !== undefined) {
    // A rich/media bubble was lost — either it failed to build (e.g. a video
    // missing its preview image) or failed to send. Preserve both generic send
    // evidence and foreground visibility: the caller surfaces the failure without
    // retrying text the user already saw.
    return {
      status: "partial",
      replyTokenUsed,
      error: markLineVisibleDeliveryError(richMediaError),
    };
  }

  return { status: "delivered", replyTokenUsed };
}
