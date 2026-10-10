import type { messagingApi } from "@line/bot-sdk";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  listMessageReceiptPlatformIds,
  type ChannelMessageSendResult,
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
  sendPayload: async ({
    to,
    payload,
    accountId,
    cfg,
    replyToId,
    onDeliveryResult,
    assertDirectAdapterHandoff,
  }) => {
    const runtime = getLineRuntime();
    const outboundRuntime = await loadLineOutboundRuntime();
    const rawLineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};
    const lineData =
      rawLineData.card && !rawLineData.flexMessage
        ? { ...rawLineData, flexMessage: renderLineCard(rawLineData.card) }
        : rawLineData;
    const location = lineData.location;
    const locationMessage = location ? outboundRuntime.createLocationMessage(location) : null;
    const {
      pushMessageLine: sendText,
      pushMessagesLine: sendBatch,
      pushFlexMessage: sendFlex,
      pushTemplateMessage: sendTemplate,
      pushLocationMessage: sendLocation,
      pushTextMessageWithQuickReplies: sendQuickReplies,
      buildTemplateMessageFromPayload: buildTemplate,
    } = outboundRuntime;
    const authorize = assertDirectAdapterHandoff
      ? () => {
          assertDirectAdapterHandoff();
          return true;
        }
      : undefined;
    const sendOptions = {
      verbose: false,
      cfg,
      accountId: accountId ?? undefined,
      authorize,
      assertDirectAdapterHandoff,
    };

    const acceptedResults: LineSendResult[] = [];
    const withAcceptedResults = (error: unknown) => {
      if (acceptedResults.length === 0) {
        return error;
      }
      const partial = isChannelPartialDeliveryError(error) ? error : undefined;
      const receipt = createMessageReceiptFromOutboundResults({
        results: [
          ...acceptedResults,
          ...(partial?.deliveryResult.receipt
            ? [{ receipt: partial.deliveryResult.receipt }]
            : (partial?.deliveryResult.messageIds ?? []).map((messageId) => ({ messageId }))),
        ],
      });
      return createChannelPartialDeliveryError(partial?.cause ?? error, {
        ...partial?.deliveryResult,
        messageIds: listMessageReceiptPlatformIds(receipt),
        receipt,
        visibleReplySent: true,
      });
    };
    const recordResult = async (
      resultPromise: Promise<LineSendResult>,
      {
        deferFailureToBatchRecovery = false,
        includeAcceptedResults = true,
      }: { deferFailureToBatchRecovery?: boolean; includeAcceptedResults?: boolean } = {},
    ): Promise<LineSendResult> => {
      let result: LineSendResult;
      try {
        result = await resultPromise;
      } catch (error) {
        if (
          deferFailureToBatchRecovery &&
          findLineHttpError(error)?.status === 400 &&
          resolveLineNonDispatchRetryable(error) !== undefined
        ) {
          throw isChannelPartialDeliveryError(error) && includeAcceptedResults
            ? withAcceptedResults(error)
            : error;
        }
        if (acceptedResults.length > 0) {
          throw includeAcceptedResults ? withAcceptedResults(error) : error;
        }
        // Accepted payload parts keep their receipt and must not wait for quota diagnosis.
        const refusal = isChannelPartialDeliveryError(error)
          ? undefined
          : await explainLineRefusal({ error, cfg, accountId });
        throw refusal?.retryable !== undefined
          ? new PlatformMessageNotDispatchedError(refusal.reason, {
              cause: error,
              retryable: refusal.retryable,
            })
          : error;
      }
      acceptedResults.push(result);
      try {
        await onDeliveryResult?.(createEmptyChannelResult("line", { ...result }));
      } catch (error) {
        // Observers run after provider acceptance; losing this receipt invites duplicate delivery.
        const receipt = createMessageReceiptFromOutboundResults({ results: acceptedResults });
        throw createChannelPartialDeliveryError(error, {
          messageIds: listMessageReceiptPlatformIds(receipt),
          receipt,
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
        ? outboundRuntime.createQuickReplyItems(quickReplies)
        : undefined;
    const quickReplyLabels = quickReplyItems.length
      ? quickReplyItems.map((item) => item.label)
      : quickReplies;
    let shouldBatchMixedPayload = false;
    const pendingMessages: messagingApi.Message[] = [];

    const sendMessageBatch = async (messages: messagingApi.Message[]) => {
      if (messages.length === 0) {
        return;
      }
      for (let i = 0; i < messages.length; i += 5) {
        const batch = messages.slice(i, i + 5);
        try {
          await recordResult(sendBatch(to, batch, sendOptions), {
            deferFailureToBatchRecovery: true,
          });
        } catch (error) {
          const httpError = findLineHttpError(error);
          if (
            !isChannelPartialDeliveryError(error) &&
            httpError?.status === 400 &&
            resolveLineNonDispatchRetryable(error) !== undefined
          ) {
            const retryCandidates = [...batch, ...messages.slice(i + batch.length)];
            const recoveryErrors: unknown[] = [];
            for (const message of retryCandidates) {
              try {
                await recordResult(sendBatch(to, [message], sendOptions), {
                  includeAcceptedResults: false,
                });
              } catch (recoveryError) {
                recoveryErrors.push(recoveryError);
              }
            }
            if (recoveryErrors.length === 0) {
              return;
            }
            const partialRecoveryErrors = recoveryErrors.filter(isChannelPartialDeliveryError);
            const recoveryResults: Array<
              Parameters<typeof createMessageReceiptFromOutboundResults>[0]["results"][number]
            > = [...acceptedResults];
            for (const recoveryError of partialRecoveryErrors) {
              const deliveryResult = recoveryError.deliveryResult;
              if (deliveryResult.receipt) {
                recoveryResults.push({ receipt: deliveryResult.receipt });
              } else {
                recoveryResults.push(
                  ...(deliveryResult.messageIds ?? []).map((messageId) => ({ messageId })),
                );
              }
            }
            const receipt = createMessageReceiptFromOutboundResults({ results: recoveryResults });
            const messageIds = listMessageReceiptPlatformIds(receipt);
            if (acceptedResults.length > 0 || messageIds.length > 0) {
              const partialRecoveryError = partialRecoveryErrors[0];
              throw createChannelPartialDeliveryError(
                partialRecoveryError?.cause ?? recoveryErrors[0] ?? error,
                {
                  ...partialRecoveryError?.deliveryResult,
                  messageIds,
                  receipt,
                  visibleReplySent: true,
                },
              );
            }
            if (partialRecoveryErrors[0] instanceof Error) {
              throw partialRecoveryErrors[0];
            }
          }
          throw isChannelPartialDeliveryError(error) ? error : withAcceptedResults(error);
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

    const processed = payload.text ? outboundRuntime.processLineMessage(payload.text) : [];

    const chunkLimit =
      runtime.channel.text.resolveTextChunkLimit?.(cfg, "line", accountId ?? undefined, {
        fallbackLimit: 5000,
      }) ?? 5000;

    const orderedMessages = processed.flatMap<messagingApi.FlexMessage | messagingApi.TextMessage>(
      (segment) =>
        segment.type === "flex"
          ? [segment.message]
          : runtime.channel.text
              .chunkMarkdownText(segment.text, chunkLimit)
              .map((text) => ({ type: "text" as const, text })),
    );
    const hasText = orderedMessages.some((message) => message.type === "text");
    const mediaUrls = resolveOutboundMediaUrls(payload);
    const mediaOptions = {
      mediaKind: lineData.mediaKind,
      previewImageUrl: lineData.previewImageUrl,
      durationMs: lineData.durationMs,
      trackingId: lineData.trackingId,
    };
    const mediaPreparationErrors: unknown[] = [];
    const shouldSendQuickRepliesInline = !hasText && hasQuickReplies;
    const templateMessage = lineData.templateMessage
      ? buildTemplate(lineData.templateMessage)
      : undefined;
    const mediaMessageCount = mediaUrls.filter((url) => Boolean(url?.trim())).length;
    const messageKinds = new Set<string>();
    if (lineData.flexMessage) {
      messageKinds.add("flex");
    }
    if (templateMessage) {
      messageKinds.add("template");
    }
    if (locationMessage) {
      messageKinds.add(locationMessage.type);
    }
    for (const message of orderedMessages) {
      messageKinds.add(message.type);
    }
    if (mediaMessageCount > 0) {
      messageKinds.add("media");
    }
    shouldBatchMixedPayload = !shouldSendQuickRepliesInline && messageKinds.size > 1;
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
            mediaPreparationErrors.push(error);
          }
        } else {
          await recordResult(
            sendText(to, "", {
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
        if (templateMessage.type === "template") {
          if (shouldBatchMixedPayload) {
            pendingMessages.push(templateMessage);
          } else {
            await recordResult(sendTemplate(to, templateMessage, sendOptions));
          }
        } else if (templateMessage) {
          if (shouldBatchMixedPayload) {
            pendingMessages.push({
              ...templateMessage,
              ...quotedOption(replyQuoteToken),
            });
          } else {
            await recordResult(
              sendText(to, templateMessage.text, {
                ...sendOptions,
                ...quotedOption(replyQuoteToken),
              }),
            );
          }
          replyQuoteToken = undefined;
        }
      }

      if (location) {
        if (shouldBatchMixedPayload && locationMessage) {
          pendingMessages.push(locationMessage);
        } else {
          await recordResult(sendLocation(to, location, sendOptions));
        }
      }
    }

    const sendMediaAfterText = !(hasQuickReplies && hasText);
    if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
      await sendMediaMessages();
    }

    if (!shouldSendQuickRepliesInline) {
      const quotedIndex = orderedMessages.findIndex(canCarryLineQuoteToken);
      if (replyQuoteToken && orderedMessages.length > 0 && quotedIndex < 0) {
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
        } else {
          if (shouldBatchMixedPayload) {
            pendingMessages.push({ ...message, ...quotedOption(quoteToken) });
          } else {
            await recordResult(
              sendText(to, message.text, { ...sendOptions, ...quotedOption(quoteToken) }),
            );
          }
        }
      }
    } else {
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
      if (lineData.templateMessage) {
        const template = buildTemplate(lineData.templateMessage);
        if (template) {
          quickReplyMessages.push(
            template.type === "text" ? { ...template, ...quotedOption(replyQuoteToken) } : template,
          );
        }
      }
      if (locationMessage) {
        quickReplyMessages.push(locationMessage);
      }
      quickReplyMessages.push(...orderedMessages);
      for (const url of mediaUrls) {
        const trimmed = url?.trim();
        if (!trimmed) {
          continue;
        }
        quickReplyMessages.push(await buildLineMediaMessage(trimmed, mediaOptions, to));
      }
      const lastMessage = quickReplyMessages.at(-1);
      if (lastMessage && quickReply) {
        const lastIndex = quickReplyMessages.length - 1;
        quickReplyMessages[lastIndex] = {
          ...lastMessage,
          quickReply,
        };
        await sendMessageBatch(quickReplyMessages);
      } else if (quickReply) {
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

    if (mediaPreparationErrors.length > 0) {
      const preparationError =
        mediaPreparationErrors.length === 1
          ? mediaPreparationErrors[0]
          : new AggregateError(
              mediaPreparationErrors,
              "Some LINE media parts could not be prepared",
            );
      const receipt = createMessageReceiptFromOutboundResults({ results: acceptedResults });
      const messageIds = listMessageReceiptPlatformIds(receipt);
      if (messageIds.length > 0) {
        throw createChannelPartialDeliveryError(preparationError, {
          messageIds,
          receipt,
          visibleReplySent: true,
        });
      }
      throw preparationError;
    }

    const completedResult = acceptedResults.at(-1);
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
    // owner, so the quote has to be resolved again; pushMessageLine puts it on the
    // caption, the one part of a media send LINE accepts a quote on.
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      accountId,
      replyToId,
      assertDirectAdapterHandoff,
    }) =>
      await (
        await loadLineOutboundRuntime()
      ).pushMessageLine(to, text, {
        verbose: false,
        mediaUrl,
        cfg,
        accountId: accountId ?? undefined,
        assertDirectAdapterHandoff,
        authorize: assertDirectAdapterHandoff
          ? () => {
              assertDirectAdapterHandoff();
              return true;
            }
          : undefined,
        quoteToken: resolveLineQuoteToken({ cfg, accountId, chatId: to, messageId: replyToId }),
      }),
  }),
};

function toLineMessageSendResult(
  result: Awaited<ReturnType<NonNullable<typeof lineOutboundAdapter.sendPayload>>>,
): ChannelMessageSendResult {
  const { receipt } = result;
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
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult));
        },
      });
      return toLineMessageSendResult(result);
    },
    media: async ({ onDeliveryResult, ...ctx }) => {
      const result = await lineOutboundAdapter.sendPayload!({
        ...ctx,
        payload: { text: ctx.text, mediaUrl: ctx.mediaUrl },
        onDeliveryResult: async (deliveryResult) => {
          await onDeliveryResult?.(toLineMessageSendResult(deliveryResult));
        },
      });
      return toLineMessageSendResult(result);
    },
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});
