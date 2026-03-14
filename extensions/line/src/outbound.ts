import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import {
  processLineMessage,
  type ChannelPlugin,
  type LineChannelData,
  type ResolvedLineAccount,
} from "../api.js";
import { resolveLineOutboundMedia, type LineOutboundMediaResolved } from "./outbound-media.js";
import { getLineRuntime } from "./runtime.js";

type LineChannelDataWithMedia = LineChannelData & {
  mediaKind?: "image" | "video" | "audio";
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

function isLineUserTarget(target: string): boolean {
  const normalized = target
    .trim()
    .replace(/^line:(group|room|user):/i, "")
    .replace(/^line:/i, "");
  return /^U/i.test(normalized);
}

function hasLineSpecificMediaOptions(lineData: LineChannelDataWithMedia): boolean {
  return Boolean(
    lineData.mediaKind ??
      lineData.previewImageUrl?.trim() ??
      (typeof lineData.durationMs === "number" ? lineData.durationMs : undefined) ??
      lineData.trackingId?.trim(),
  );
}

function buildLineMediaMessageObject(
  resolved: LineOutboundMediaResolved,
  opts?: { allowTrackingId?: boolean },
): Record<string, unknown> {
  switch (resolved.mediaKind) {
    case "video": {
      const previewImageUrl = resolved.previewImageUrl?.trim();
      if (!previewImageUrl) {
        throw new Error("LINE video messages require previewImageUrl to reference an image URL");
      }
      return {
        type: "video",
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl,
        ...(opts?.allowTrackingId && resolved.trackingId
          ? { trackingId: resolved.trackingId }
          : {}),
      };
    }
    case "audio":
      return {
        type: "audio",
        originalContentUrl: resolved.mediaUrl,
        duration: resolved.durationMs ?? 60000,
      };
    default:
      return {
        type: "image",
        originalContentUrl: resolved.mediaUrl,
        previewImageUrl: resolved.previewImageUrl ?? resolved.mediaUrl,
      };
  }
}

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: 5000,
  sendPayload: async ({ to, payload, accountId, cfg, mediaLocalRoots }) => {
    const runtime = getLineRuntime();
    const lineData = (payload.channelData?.line as LineChannelDataWithMedia | undefined) ?? {};
    const sendText = runtime.channel.line.pushMessageLine;
    const sendBatch = runtime.channel.line.pushMessagesLine;
    const sendFlex = runtime.channel.line.pushFlexMessage;
    const sendTemplate = runtime.channel.line.pushTemplateMessage;
    const sendLocation = runtime.channel.line.pushLocationMessage;
    const sendQuickReplies = runtime.channel.line.pushTextMessageWithQuickReplies;
    const buildTemplate = runtime.channel.line.buildTemplateMessageFromPayload;
    const createQuickReplyItems = runtime.channel.line.createQuickReplyItems;

    let lastResult: { messageId: string; chatId: string } | null = null;
    const quickReplies = lineData.quickReplies ?? [];
    const hasQuickReplies = quickReplies.length > 0;
    const quickReply = hasQuickReplies ? createQuickReplyItems(quickReplies) : undefined;

    // LINE SDK expects Message[] but we build dynamically.
    const sendMessageBatch = async (messages: Array<Record<string, unknown>>) => {
      if (messages.length === 0) {
        return;
      }
      for (let i = 0; i < messages.length; i += 5) {
        const batch = messages.slice(i, i + 5) as unknown as Parameters<typeof sendBatch>[1];
        const result = await sendBatch(to, batch, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
        lastResult = { messageId: result.messageId, chatId: result.chatId };
      }
    };

    const processed = payload.text
      ? processLineMessage(payload.text)
      : { text: "", flexMessages: [] };

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;

    const chunks = processed.text
      ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit)
      : [];
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const useLineSpecificMedia = hasLineSpecificMediaOptions(lineData);
    const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
    const sendMediaMessages = async () => {
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        if (!useLineSpecificMedia) {
          lastResult = await runtime.channel.line.sendMessageLine(to, "", {
            verbose: false,
            mediaUrl: trimmed,
            cfg,
            accountId: accountId ?? undefined,
          });
          continue;
        }
        const resolved = await resolveLineOutboundMedia(trimmed, {
          mediaLocalRoots,
          mediaKind: lineData.mediaKind,
          previewImageUrl: lineData.previewImageUrl,
          durationMs: lineData.durationMs,
          trackingId: lineData.trackingId,
        });
        lastResult = await runtime.channel.line.sendMessageLine(to, "", {
          verbose: false,
          mediaUrl: resolved.mediaUrl,
          mediaKind: resolved.mediaKind,
          previewImageUrl: resolved.previewImageUrl,
          durationMs: resolved.durationMs,
          trackingId: resolved.trackingId,
          cfg,
          accountId: accountId ?? undefined,
        });
      }
    };

    if (!shouldSendQuickRepliesInline) {
      if (lineData.flexMessage) {
        const flexContents = lineData.flexMessage.contents as Parameters<typeof sendFlex>[2];
        lastResult = await sendFlex(to, lineData.flexMessage.altText, flexContents, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
      }

      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          lastResult = await sendTemplate(to, template, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        }
      }

      if (lineData.location) {
        lastResult = await sendLocation(to, lineData.location, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
      }

      for (const flexMsg of processed.flexMessages) {
        const flexContents = flexMsg.contents as Parameters<typeof sendFlex>[2];
        lastResult = await sendFlex(to, flexMsg.altText, flexContents, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
      }
    }

    const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (chunks.length > 0) {
      for (let i = 0; i < chunks.length; i += 1) {
        const isLast = i === chunks.length - 1;
        if (isLast && hasQuickReplies) {
          lastResult = await sendQuickReplies(to, chunks[i], quickReplies, {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        } else {
          lastResult = await sendText(to, chunks[i], {
            verbose: false,
            cfg,
            accountId: accountId ?? undefined,
          });
        }
      }
    } else if (shouldSendQuickRepliesInline) {
      const quickReplyMessages: Array<Record<string, unknown>> = [];
      if (lineData.flexMessage) {
        quickReplyMessages.push({
          type: "flex",
          altText: lineData.flexMessage.altText.slice(0, 400),
          contents: lineData.flexMessage.contents,
        });
      }
      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          quickReplyMessages.push(template);
        }
      }
      if (lineData.location) {
        quickReplyMessages.push({
          type: "location",
          title: lineData.location.title.slice(0, 100),
          address: lineData.location.address.slice(0, 100),
          latitude: lineData.location.latitude,
          longitude: lineData.location.longitude,
        });
      }
      for (const flexMsg of processed.flexMessages) {
        quickReplyMessages.push({
          type: "flex",
          altText: flexMsg.altText.slice(0, 400),
          contents: flexMsg.contents,
        });
      }
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        if (!useLineSpecificMedia) {
          quickReplyMessages.push({
            type: "image",
            originalContentUrl: trimmed,
            previewImageUrl: trimmed,
          });
          continue;
        }
        const resolved = await resolveLineOutboundMedia(trimmed, {
          mediaLocalRoots,
          mediaKind: lineData.mediaKind,
          previewImageUrl: lineData.previewImageUrl,
          durationMs: lineData.durationMs,
          trackingId: lineData.trackingId,
        });
        quickReplyMessages.push(
          buildLineMediaMessageObject(resolved, { allowTrackingId: isLineUserTarget(to) }),
        );
      }
      if (quickReplyMessages.length > 0 && quickReply) {
        const lastIndex = quickReplyMessages.length - 1;
        quickReplyMessages[lastIndex] = {
          ...quickReplyMessages[lastIndex],
          quickReply,
        };
        await sendMessageBatch(quickReplyMessages);
      }
    }

    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (lastResult) {
      return createEmptyChannelResult("line", { ...lastResult });
    }
    return createEmptyChannelResult("line", { messageId: "empty", chatId: to });
  },
  ...createAttachedChannelResultAdapter({
    channel: "line",
    sendText: async ({ cfg, to, text, accountId }) => {
      const runtime = getLineRuntime();
      const sendText = runtime.channel.line.pushMessageLine;
      const sendFlex = runtime.channel.line.pushFlexMessage;
      const processed = processLineMessage(text);
      let result: { messageId: string; chatId: string };
      if (processed.text.trim()) {
        result = await sendText(to, processed.text, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
      } else {
        result = { messageId: "processed", chatId: to };
      }
      for (const flexMsg of processed.flexMessages) {
        const flexContents = flexMsg.contents as Parameters<typeof sendFlex>[2];
        await sendFlex(to, flexMsg.altText, flexContents, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
        });
      }
      return result;
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) =>
      await getLineRuntime().channel.line.sendMessageLine(to, text, {
        verbose: false,
        mediaUrl,
        cfg,
        accountId: accountId ?? undefined,
      }),
  }),
};
