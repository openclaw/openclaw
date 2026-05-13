// Line plugin module implements auto reply delivery behavior.
import type { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { FlexContainer } from "./flex-templates.js";
import type { ProcessedLineMessage } from "./markdown-to-line.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import type { SendLineReplyChunksParams } from "./reply-chunks.js";
import type { LineChannelData, LineTemplateMessagePayload } from "./types.js";

export type LineAutoReplyDeps = {
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

export async function deliverLineAutoReply(params: {
  payload: ReplyPayload;
  lineData: LineChannelData;
  to: string;
  replyToken?: string | null;
  replyTokenUsed: boolean;
  accountId?: string;
  cfg: OpenClawConfig;
  textLimit: number;
  deps: LineAutoReplyDeps;
}): Promise<{ replyTokenUsed: boolean }> {
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
        lineData.flexMessage.altText.slice(0, 400),
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
    richMessages.push(deps.createFlexMessage(flexMsg.altText.slice(0, 400), flexMsg.contents));
  }

  const chunks = processed.text ? deps.chunkMarkdownText(processed.text, textLimit) : [];

  const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
  const mediaMessages = mediaUrls
    .map((url) => url?.trim())
    .filter((url): url is string => Boolean(url))
    .map((url) => deps.createImageMessage(url));

  if (chunks.length > 0) {
    const hasRichOrMedia = richMessages.length > 0 || mediaMessages.length > 0;
    if (hasQuickReplies && hasRichOrMedia) {
      // Quick replies must attach to the LAST message in the reply batch.
      // To keep them visible, the original flow sends rich/media on the Push
      // API FIRST and then attaches the quick reply to the trailing text in
      // the Reply API. Preserve that quick-reply ordering.
      try {
        await sendLineMessages([...richMessages, ...mediaMessages], false);
      } catch (err) {
        deps.onReplyError?.(err);
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
    } else if (replyToken && !replyTokenUsed && hasRichOrMedia) {
      // No quick replies, but we have rich/media + text. Pack everything that
      // fits into the single 5-slot Reply API call (LINE max) before the
      // reply token is consumed; push only the overflow. This avoids the
      // free-plan 429 on Push API when text reaches via Reply and rich
      // messages would otherwise fall to Push (#65656).
      const REPLY_API_MAX = 5;
      const richAndMedia: messagingApi.Message[] = [...richMessages, ...mediaMessages];
      const textChunkMessages: messagingApi.Message[] = chunks.map((chunk) => ({
        type: "text",
        text: chunk,
      }));
      const replyBatch = [...richAndMedia, ...textChunkMessages].slice(0, REPLY_API_MAX);
      const overflow = [...richAndMedia, ...textChunkMessages].slice(REPLY_API_MAX);
      try {
        await deps.replyMessageLine(replyToken, replyBatch, {
          cfg: params.cfg,
          accountId,
        });
        replyTokenUsed = true;
        if (overflow.length > 0) {
          await pushLineMessages(overflow);
        }
      } catch (err) {
        deps.onReplyError?.(err);
        // Fall back to the original split: reply-chunks for text, push for rich/media.
        replyTokenUsed = true;
        await pushLineMessages(replyBatch);
        if (overflow.length > 0) {
          await pushLineMessages(overflow);
        }
      }
    } else {
      // Either no rich/media (text-only) or reply token already used: keep
      // the existing reply-chunks path. If rich/media exist when reply token
      // is already used (e.g. error fallback), push them after the text.
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
      if (hasRichOrMedia) {
        await sendLineMessages(richMessages, false);
        if (mediaMessages.length > 0) {
          await sendLineMessages(mediaMessages, false);
        }
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

  return { replyTokenUsed };
}
