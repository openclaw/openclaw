import type { messagingApi } from "@line/bot-sdk";
import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
// Line plugin module implements outbound behavior.
import {
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
  type MessageReceipt,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { buildLineMediaMessage } from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import {
  applyLineQuoteToken,
  canCarryLineQuoteToken,
  reportLineQuoteCarrierMissing,
  resolveLineQuoteToken,
} from "./quote-tokens.js";
import {
  createLineQuickReply,
  LINE_PRESENTATION_CAPABILITIES,
  renderLineCard,
  renderLinePresentation,
} from "./rich-messages.js";
import { getLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";
import { explainLineRefusal } from "./send-retry.js";
import type { LineChannelData, LineSendResult, ResolvedLineAccount } from "./types.js";

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: 5000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  presentationCapabilities: LINE_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation, sourcePresentation, ctx }) =>
    renderLinePresentation(payload, presentation, ctx.to, sourcePresentation),
  sendPayload: async ({ to, payload, accountId, cfg, replyToId, onDeliveryResult }) => {
    const runtime = getLineRuntime();
    const outboundRuntime = await loadLineOutboundRuntime();
    const rawLineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};
    const lineData =
      rawLineData.card && !rawLineData.flexMessage
        ? { ...rawLineData, flexMessage: renderLineCard(rawLineData.card) }
        : rawLineData;
    const lineRuntime = runtime.channel.line;
    const location = lineData.location;
    const locationMessage = location ? outboundRuntime.createLocationMessage(location) : null;
    const sendBatch = lineRuntime?.pushMessagesLine ?? outboundRuntime.pushMessagesLine;
    const buildTemplate =
      lineRuntime?.buildTemplateMessageFromPayload ??
      outboundRuntime.buildTemplateMessageFromPayload;
    const sendOptions = { verbose: false, cfg, accountId: accountId ?? undefined };

    let lastResult: LineSendResult | null = null;
    const accepted: LineSendResult[] = [];
    // Whatever already reached the chat travels with every later failure; a bare
    // rejection reads as a delivery that never started and invites a replay.
    const asPartialDelivery = (
      error: unknown,
      alsoDelivered?: { receipt?: MessageReceipt; messageIds?: string[] },
    ) => {
      const delivered = createAcceptedChannelDeliveryResult({
        deliveryResults: [
          ...accepted.map((result) => ({ receipt: result.receipt })),
          ...(alsoDelivered ? [alsoDelivered] : []),
        ],
      });
      // Each request numbers its own parts from zero, so the merged receipt has
      // to renumber them to keep naming a position in the whole payload.
      delivered.receipt.parts = delivered.receipt.parts.map((part, index) => ({ ...part, index }));
      return createChannelPartialDeliveryError(error, delivered);
    };
    const recordResult = async (
      resultPromise: Promise<LineSendResult>,
    ): Promise<LineSendResult> => {
      let result: LineSendResult;
      try {
        result = await resultPromise;
      } catch (error) {
        if (accepted.length > 0) {
          // Accepted requests keep their receipts and must not wait for quota
          // diagnosis; a failure carrying evidence of its own joins them rather
          // than replacing them.
          throw asPartialDelivery(
            error,
            isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined,
          );
        }
        const refusal = isChannelPartialDeliveryError(error)
          ? undefined
          : await explainLineRefusal({ error, cfg, accountId });
        if (refusal?.retryable !== undefined) {
          throw new PlatformMessageNotDispatchedError(refusal.reason, {
            cause: error,
            retryable: refusal.retryable,
          });
        }
        throw error;
      }
      lastResult = result;
      accepted.push(result);
      try {
        await onDeliveryResult?.(createEmptyChannelResult("line", { ...result }));
      } catch (error) {
        // Observers run after provider acceptance; losing this receipt invites duplicate delivery.
        throw asPartialDelivery(error);
      }
      return result;
    };
    const quickReplies = lineData.quickReplies ?? [];
    const quickReplyItems = lineData.quickReplyItems ?? [];
    const hasQuickReplies = quickReplies.length > 0 || quickReplyItems.length > 0;
    const quickReply = quickReplyItems.length
      ? createLineQuickReply(quickReplyItems)
      : quickReplies.length
        ? (lineRuntime?.createQuickReplyItems ?? outboundRuntime.createQuickReplyItems)(
            quickReplies,
          )
        : undefined;
    const quickReplyLabels = quickReplyItems.length
      ? quickReplyItems.map((item) => item.label)
      : quickReplies;

    // LINE charges one monthly message per request per recipient, whatever the
    // request carries, so a payload's parts travel together up to the batch cap.
    const sendMessageBatch = async (messages: messagingApi.Message[]) => {
      for (let i = 0; i < messages.length; i += 5) {
        await recordResult(sendBatch(to, messages.slice(i, i + 5), sendOptions));
      }
    };

    const processed = payload.text
      ? outboundRuntime.processLineMessage(payload.text)
      : { text: "", flexMessages: [] };

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;
    const chunkTextMessages = (text: string): messagingApi.TextMessage[] =>
      runtime.channel.text
        .chunkMarkdownText(text, chunkLimit)
        .map((chunk) => ({ type: "text" as const, text: chunk }));

    const orderedMessages = processed.segments?.flatMap<
      messagingApi.FlexMessage | messagingApi.TextMessage
    >((segment) => (segment.type === "flex" ? [segment.message] : chunkTextMessages(segment.text)));
    const bodyMessages: messagingApi.Message[] =
      orderedMessages ?? (processed.text ? chunkTextMessages(processed.text) : []);

    const richMessages: messagingApi.Message[] = [];
    if (lineData.flexMessage) {
      richMessages.push(
        outboundRuntime.createFlexMessage(
          lineData.flexMessage.altText,
          lineData.flexMessage.contents as Parameters<typeof outboundRuntime.createFlexMessage>[1],
        ),
      );
    }
    if (lineData.templateMessage) {
      const template = buildTemplate(lineData.templateMessage);
      if (template) {
        richMessages.push(template);
      }
    }
    if (locationMessage) {
      richMessages.push(locationMessage);
    }
    if (!orderedMessages) {
      for (const flexMsg of processed.flexMessages) {
        richMessages.push(outboundRuntime.createFlexMessage(flexMsg.altText, flexMsg.contents));
      }
    }

    const mediaOptions = {
      mediaKind: lineData.mediaKind,
      previewImageUrl: lineData.previewImageUrl,
      durationMs: lineData.durationMs,
      trackingId: lineData.trackingId,
    };
    const mediaMessages: messagingApi.Message[] = [];
    let deliveryError: Error | undefined;
    for (const rawUrl of resolveOutboundMediaUrls(payload)) {
      const url = rawUrl?.trim();
      if (!url) {
        continue;
      }
      try {
        mediaMessages.push(await buildLineMediaMessage(url, mediaOptions, to));
      } catch (error) {
        // Media LINE will not carry must not take the text that came with it.
        // Only the first cause is surfaced, so later ones are recorded here
        // rather than disappearing.
        if (deliveryError) {
          logVerbose(`line: another outbound media message could not be built: ${String(error)}`);
          continue;
        }
        deliveryError =
          error instanceof Error
            ? error
            : new Error("LINE outbound media could not be prepared", { cause: error });
      }
    }

    // Quick replies disappear as soon as a newer message arrives, so the text
    // that carries them has to stay last and the media moves ahead of it.
    const quickRepliesRideText =
      hasQuickReplies && bodyMessages.some((message) => message.type === "text");
    const messages: messagingApi.Message[] = quickRepliesRideText
      ? [...richMessages, ...mediaMessages, ...bodyMessages]
      : [...richMessages, ...bodyMessages, ...mediaMessages];
    if (hasQuickReplies && messages.length === 0 && deliveryError === undefined) {
      // The fallback carries quick replies for a payload that had nothing else;
      // one whose only content failed to build surfaces that failure instead.
      messages.push({ type: "text", text: buildLineQuickReplyFallbackText(quickReplyLabels) });
    }
    const lastMessage = messages.at(-1);
    if (quickReply && lastMessage) {
      messages[messages.length - 1] = { ...lastMessage, quickReply };
    }

    // LINE renders a quote on one bubble, so a reply spends its token on the first
    // message able to carry it, whichever request of the batch that lands in.
    const replyQuoteToken = resolveLineQuoteToken({
      cfg,
      accountId,
      chatId: to,
      messageId: replyToId,
    });
    if (replyQuoteToken && !messages.some(canCarryLineQuoteToken)) {
      reportLineQuoteCarrierMissing(to);
    }
    await sendMessageBatch(applyLineQuoteToken(messages, replyQuoteToken));
    const completedResult = lastResult as LineSendResult | null;
    if (deliveryError !== undefined) {
      if (!completedResult) {
        throw deliveryError;
      }
      throw asPartialDelivery(deliveryError);
    }
    if (!completedResult) {
      throw new Error("Message must be non-empty for LINE sends");
    }
    return createEmptyChannelResult("line", { ...completedResult });
  },
  ...createAttachedChannelResultAdapter({
    channel: "line",
    // The payload owner records each physical send before the next fallible step;
    // bypassing it fabricates Flex-only ids and loses partial-delivery evidence.
    sendText: async (ctx) =>
      await lineOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: ctx.text },
      }),
    // Core sends a single media reply through here rather than through the payload
    // owner, so the quote has to be resolved again; sendMessageLine puts it on the
    // caption, the one part of a media send LINE accepts a quote on.
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) =>
      await (
        await loadLineOutboundRuntime()
      ).sendMessageLine(to, text, {
        verbose: false,
        mediaUrl,
        cfg,
        accountId: accountId ?? undefined,
        quoteToken: resolveLineQuoteToken({ cfg, accountId, chatId: to, messageId: replyToId }),
      }),
  }),
};

function toLineMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof lineOutboundAdapter.sendPayload>>>,
  kind: MessageReceiptPartKind,
): ChannelMessageSendResult {
  const source = result as typeof result & { chatId?: string };
  const receipt =
    result.receipt ??
    (result.messageId
      ? createLineSendReceipt({
          messageId: result.messageId,
          chatId: source.chatId ?? "",
          kind,
        })
      : undefined);
  if (!receipt) {
    throw new Error("LINE message adapter send did not return a receipt");
  }
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

export const lineMessageAdapter = defineChannelMessageAdapter({
  id: "line",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      // Core withholds durable final delivery from any payload whose declared
      // capabilities it cannot find, so a reply that names a target has to say so.
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    // Core owns this context; forward it whole. Picking fields by hand is how the
    // reply target it resolved stopped reaching the send.
    text: async ({ onDeliveryResult, ...ctx }) => {
      const result = await lineOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: ctx.text },
        onDeliveryResult: async (deliveryResult) => {
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult, "text"));
        },
      });
      return toLineMessageSendResult(result, "text");
    },
    media: async ({ onDeliveryResult, ...ctx }) => {
      const result = await lineOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: ctx.text, mediaUrl: ctx.mediaUrl },
        onDeliveryResult: async (deliveryResult) => {
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult, "media"));
        },
      });
      return toLineMessageSendResult(result, "media");
    },
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});
