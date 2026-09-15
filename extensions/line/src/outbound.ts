import type { messagingApi } from "@line/bot-sdk";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
// Line plugin module implements outbound behavior.
import {
  defineChannelMessageAdapter,
  listMessageReceiptPlatformIds,
  type ChannelMessageSendResult,
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
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { buildLineMediaMessage } from "./outbound-media.js";
import { buildLineQuickReplyFallbackText } from "./quick-reply-fallback.js";
import {
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
import {
  explainLineRefusal,
  findLineHttpError,
  resolveLineNonDispatchRetryable,
} from "./send-retry.js";
import type { LineChannelData, LineSendResult, ResolvedLineAccount } from "./types.js";

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

function quotedOption(quoteToken: string | undefined): { quoteToken?: string } {
  return quoteToken ? { quoteToken } : {};
}

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
    const sendText = lineRuntime?.pushMessageLine ?? outboundRuntime.pushMessageLine;
    const sendBatch = lineRuntime?.pushMessagesLine ?? outboundRuntime.pushMessagesLine;
    const sendFlex = lineRuntime?.pushFlexMessage ?? outboundRuntime.pushFlexMessage;
    const sendTemplate = lineRuntime?.pushTemplateMessage ?? outboundRuntime.pushTemplateMessage;
    const sendLocation = lineRuntime?.pushLocationMessage ?? outboundRuntime.pushLocationMessage;
    const sendQuickReplies =
      lineRuntime?.pushTextMessageWithQuickReplies ??
      outboundRuntime.pushTextMessageWithQuickReplies;
    const buildTemplate =
      lineRuntime?.buildTemplateMessageFromPayload ??
      outboundRuntime.buildTemplateMessageFromPayload;
    const sendOptions = { verbose: false, cfg, accountId: accountId ?? undefined };

    let lastResult: LineSendResult | null = null;
    const recordResult = async (
      resultPromise: Promise<LineSendResult>,
    ): Promise<LineSendResult> => {
      let result: LineSendResult;
      try {
        result = await resultPromise;
      } catch (error) {
        // Accepted payload parts keep their receipt and must not wait for quota diagnosis.
        const refusal =
          lastResult !== null || isChannelPartialDeliveryError(error)
            ? undefined
            : await explainLineRefusal({ error, cfg, accountId });
        throw refusal?.retryable !== undefined
          ? new PlatformMessageNotDispatchedError(refusal.reason, {
              cause: error,
              retryable: refusal.retryable,
            })
          : error;
      }
      lastResult = result;
      try {
        await onDeliveryResult?.(createEmptyChannelResult("line", { ...result }));
      } catch (error) {
        // Observers run after provider acceptance; losing this receipt invites duplicate delivery.
        throw createChannelPartialDeliveryError(error, {
          messageIds: listMessageReceiptPlatformIds(result.receipt),
          receipt: result.receipt,
          visibleReplySent: true,
        });
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

    // LINE SDK expects Message[] but we build dynamically.
    const sendMessageBatch = async (
      messages: messagingApi.Message[],
      allowRejectedBatchRecovery = true,
    ) => {
      if (messages.length === 0) {
        return;
      }
      for (let i = 0; i < messages.length; i += 5) {
        const batch = messages.slice(i, i + 5) as Parameters<typeof sendBatch>[1];
        try {
          await recordResult(sendBatch(to, batch, sendOptions));
        } catch (error) {
          const httpError = findLineHttpError(error);
          if (
            allowRejectedBatchRecovery &&
            httpError?.status === 400 &&
            resolveLineNonDispatchRetryable(error) !== undefined
          ) {
            const retryCandidates = [...batch, ...messages.slice(i + batch.length)];
            const retryTextMessages = retryCandidates.filter(
              (message): message is messagingApi.TextMessage => message.type === "text",
            );
            const quickRepliesNeedCarrier = retryCandidates.some(
              (message) => "quickReply" in message,
            );
            const retryMessages: messagingApi.Message[] = retryTextMessages.length
              ? [...retryTextMessages]
              : quickRepliesNeedCarrier && quickReply
                ? [
                    {
                      type: "text",
                      text: buildLineQuickReplyFallbackText(quickReplyLabels),
                      quickReply,
                    },
                  ]
                : [];
            if (quickRepliesNeedCarrier && quickReply && retryMessages.length > 0) {
              const lastRetryMessage = retryMessages.at(-1);
              if (lastRetryMessage && !("quickReply" in lastRetryMessage)) {
                retryMessages[retryMessages.length - 1] = {
                  ...lastRetryMessage,
                  quickReply,
                };
              }
            }
            if (retryMessages.length > 0) {
              let recoveryFailed = false;
              let recoveryError: unknown;
              try {
                await sendMessageBatch(retryMessages, false);
              } catch (recoveryFailure) {
                recoveryFailed = true;
                recoveryError = recoveryFailure;
              }
              if (recoveryFailed) {
                // The fallback owns the latest delivery evidence. Do not replace
                // an accepted or ambiguous fallback outcome with the first batch's
                // definitive rejection.
                throw recoveryError;
              }
              if (lastResult !== null) {
                throw createChannelPartialDeliveryError(error, {
                  messageIds: listMessageReceiptPlatformIds(lastResult.receipt),
                  receipt: lastResult.receipt,
                  visibleReplySent: true,
                });
              }
            }
          }
          throw error;
        }
      }
    };

    // LINE renders a quote on one bubble, so a reply spends its token on the first
    // text it sends and every later part of the same reply goes out unquoted.
    let replyQuoteToken = resolveLineQuoteToken({
      cfg,
      accountId,
      chatId: to,
      messageId: replyToId,
    });
    const sendTextWithQuickReply = async (text: string, quoteToken?: string) => {
      if (shouldBatchMixedPayload && quickReply) {
        pendingMessages.push({ type: "text", text, quickReply, ...quotedOption(quoteToken) });
        return;
      }
      if (quickReplyItems.length > 0 && quickReply) {
        await sendMessageBatch([{ type: "text", text, quickReply, ...quotedOption(quoteToken) }]);
        return;
      }
      await recordResult(
        sendQuickReplies(to, text, quickReplies, { ...sendOptions, ...quotedOption(quoteToken) }),
      );
    };

    const processed = payload.text
      ? outboundRuntime.processLineMessage(payload.text)
      : { text: "", flexMessages: [] };

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;

    const orderedMessages = processed.segments?.flatMap<
      messagingApi.FlexMessage | messagingApi.TextMessage
    >((segment) =>
      segment.type === "flex"
        ? [segment.message]
        : runtime.channel.text
            .chunkMarkdownText(segment.text, chunkLimit)
            .map((text) => ({ type: "text" as const, text })),
    );
    const chunks = orderedMessages
      ? orderedMessages.flatMap((message) => (message.type === "text" ? [message.text] : []))
      : processed.text
        ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit)
        : [];
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const mediaOptions = {
      mediaKind: lineData.mediaKind,
      previewImageUrl: lineData.previewImageUrl,
      durationMs: lineData.durationMs,
      trackingId: lineData.trackingId,
    };
    const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
    const templateMessage = lineData.templateMessage
      ? buildTemplate(lineData.templateMessage)
      : undefined;
    const richMessageCount =
      Number(Boolean(lineData.flexMessage)) +
      Number(Boolean(templateMessage)) +
      Number(Boolean(location)) +
      (orderedMessages ? 0 : processed.flexMessages.length);
    const textMessageCount = orderedMessages?.length ?? chunks.length;
    const mediaMessageCount = mediaUrls.filter((url) => Boolean(url?.trim())).length;
    const shouldBatchMixedPayload =
      !shouldSendQuickRepliesInline && richMessageCount + textMessageCount + mediaMessageCount > 1;
    const pendingMessages: messagingApi.Message[] = [];
    let mediaPreparationError: unknown;
    const sendMediaMessages = async () => {
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        if (shouldBatchMixedPayload) {
          try {
            pendingMessages.push(await buildLineMediaMessage(trimmed, mediaOptions, to));
          } catch (error) {
            // Keep valid parts in the batch; report the failed media after they land.
            mediaPreparationError ??= error;
          }
        } else {
          await recordResult(
            (lineRuntime?.sendMessageLine ?? outboundRuntime.sendMessageLine)(to, "", {
              ...sendOptions,
              ...mediaOptions,
              mediaUrl: trimmed,
            }),
          );
        }
      }
    };

    if (!shouldSendQuickRepliesInline) {
      if (lineData.flexMessage) {
        const flexContents = lineData.flexMessage.contents as Parameters<typeof sendFlex>[2];
        if (shouldBatchMixedPayload) {
          pendingMessages.push(
            outboundRuntime.createFlexMessage(lineData.flexMessage.altText, flexContents),
          );
        } else {
          await recordResult(sendFlex(to, lineData.flexMessage.altText, flexContents, sendOptions));
        }
      }

      if (templateMessage) {
        const template = templateMessage;
        if (template?.type === "template") {
          if (shouldBatchMixedPayload) {
            pendingMessages.push(template);
          } else {
            await recordResult(sendTemplate(to, template, sendOptions));
          }
        } else if (template) {
          if (shouldBatchMixedPayload) {
            pendingMessages.push({ ...template, ...quotedOption(replyQuoteToken) });
            replyQuoteToken = undefined;
          } else {
            await recordResult(
              sendText(to, template.text, { ...sendOptions, ...quotedOption(replyQuoteToken) }),
            );
            replyQuoteToken = undefined;
          }
        }
      }

      if (location) {
        if (shouldBatchMixedPayload) {
          pendingMessages.push(locationMessage!);
        } else {
          await recordResult(sendLocation(to, location, sendOptions));
        }
      }

      if (!orderedMessages) {
        for (const flexMsg of processed.flexMessages) {
          if (shouldBatchMixedPayload) {
            pendingMessages.push(
              outboundRuntime.createFlexMessage(flexMsg.altText, flexMsg.contents),
            );
          } else {
            await recordResult(sendFlex(to, flexMsg.altText, flexMsg.contents, sendOptions));
          }
        }
      }
    }

    const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (orderedMessages && !shouldSendQuickRepliesInline) {
      const quotedIndex = orderedMessages.findIndex(canCarryLineQuoteToken);
      if (replyQuoteToken && quotedIndex < 0) {
        reportLineQuoteCarrierMissing(to);
      }
      for (const [index, message] of orderedMessages.entries()) {
        const isLast = index === orderedMessages.length - 1;
        const quoteToken = index === quotedIndex ? replyQuoteToken : undefined;
        if (message.type === "flex") {
          if (isLast && quickReply) {
            if (shouldBatchMixedPayload) {
              pendingMessages.push({ ...message, quickReply });
            } else {
              await sendMessageBatch([{ ...message, quickReply }]);
            }
          } else if (shouldBatchMixedPayload) {
            pendingMessages.push(message);
          } else {
            await recordResult(sendFlex(to, message.altText, message.contents, sendOptions));
          }
        } else if (isLast && hasQuickReplies) {
          await sendTextWithQuickReply(message.text, quoteToken);
        } else if (shouldBatchMixedPayload) {
          pendingMessages.push({ ...message, ...quotedOption(quoteToken) });
        } else {
          await recordResult(
            sendText(to, message.text, { ...sendOptions, ...quotedOption(quoteToken) }),
          );
        }
      }
    } else if (chunks.length > 0) {
      for (const [i, chunk] of chunks.entries()) {
        const isLast = i === chunks.length - 1;
        const quoteToken = i === 0 ? replyQuoteToken : undefined;
        if (isLast && hasQuickReplies) {
          await sendTextWithQuickReply(chunk, quoteToken);
        } else if (shouldBatchMixedPayload) {
          pendingMessages.push({ type: "text", text: chunk, ...quotedOption(quoteToken) });
        } else {
          await recordResult(sendText(to, chunk, { ...sendOptions, ...quotedOption(quoteToken) }));
        }
      }
    } else if (shouldSendQuickRepliesInline) {
      const quickReplyMessages: messagingApi.Message[] = [];
      if (lineData.flexMessage) {
        quickReplyMessages.push(
          outboundRuntime.createFlexMessage(
            lineData.flexMessage.altText,
            lineData.flexMessage.contents as Parameters<
              typeof outboundRuntime.createFlexMessage
            >[1],
          ),
        );
      }
      if (templateMessage) {
        const template = templateMessage;
        if (template) {
          quickReplyMessages.push(
            template.type === "text" ? { ...template, ...quotedOption(replyQuoteToken) } : template,
          );
        }
      }
      if (locationMessage) {
        quickReplyMessages.push(locationMessage);
      }
      for (const flexMsg of processed.flexMessages) {
        quickReplyMessages.push(
          outboundRuntime.createFlexMessage(flexMsg.altText, flexMsg.contents),
        );
      }
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        try {
          quickReplyMessages.push(await buildLineMediaMessage(trimmed, mediaOptions, to));
        } catch (error) {
          mediaPreparationError ??= error;
        }
      }
      if (quickReplyMessages.length > 0 && quickReply) {
        const lastIndex = quickReplyMessages.length - 1;
        const lastMessage = quickReplyMessages[lastIndex];
        if (lastMessage) {
          quickReplyMessages[lastIndex] = { ...lastMessage, quickReply };
        }
        await sendMessageBatch(quickReplyMessages);
      } else if (quickReply && mediaPreparationError === undefined) {
        await sendTextWithQuickReply(
          buildLineQuickReplyFallbackText(quickReplyLabels),
          replyQuoteToken,
        );
      }
    }

    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (shouldBatchMixedPayload) {
      await sendMessageBatch(pendingMessages);
    }

    const completedResult = lastResult as LineSendResult | null;
    if (mediaPreparationError !== undefined) {
      if (completedResult) {
        throw createChannelPartialDeliveryError(mediaPreparationError, {
          messageIds: listMessageReceiptPlatformIds(completedResult.receipt),
          receipt: completedResult.receipt,
          visibleReplySent: true,
        });
      }
      throw mediaPreparationError instanceof Error
        ? mediaPreparationError
        : new Error("LINE media preparation failed", { cause: mediaPreparationError });
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
