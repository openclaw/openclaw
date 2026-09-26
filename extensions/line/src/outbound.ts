import type { messagingApi } from "@line/bot-sdk";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
// Line plugin module implements outbound behavior.
import {
  createChannelMessageAdapterFromOutbound,
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  listMessageReceiptPlatformIds,
  type ChannelMessageUnknownSendContext,
  type ChannelMessageUnknownSendReconciliationResult,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
  type OutboundDeliveryResult,
} from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { normalizeLineMessage } from "./actions.js";
import {
  clearLineDurableSendPlans,
  LineDurableSendPlanError,
  loadLineDurableSendPlans,
  recordLineDurableSendPlan,
} from "./durable-send-plan.js";
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
import {
  explainLineRefusal,
  isLineRequestRejection,
  isLineRetryKeyExpiredError,
  LINE_RETRY_KEY_TTL_MS,
  resolveLineNonDispatchRetryable,
  resolveLinePushRetryKey,
} from "./send-retry.js";
import type { LineChannelData, LineSendResult, ResolvedLineAccount } from "./types.js";

type LineOutboundMessage = messagingApi.Message;

type LineSendPayloadContext = Parameters<
  NonNullable<NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]>["sendPayload"]>
>[0];

const loadLineOutboundRuntime = createLazyRuntimeModule(() => import("./outbound.runtime.js"));

/** One payload crosses the platform boundary once, however many pushes it fans out into. */
function createDispatchOnce(onPlatformSendDispatch?: () => Promise<void>): () => Promise<void> {
  let dispatched = false;
  return async () => {
    if (dispatched) {
      return;
    }
    await onPlatformSendDispatch?.();
    dispatched = true;
  };
}

/** Renders one delivery part into every push it will make before sending any of them. */
async function sendLinePayload({
  to,
  payload,
  accountId,
  cfg,
  replyToId,
  deliveryQueueId,
  deliveryPartIndex,
  deliveryPartCount,
  onPlatformSendDispatch,
  onDeliveryResult,
  assertDirectAdapterHandoff,
}: LineSendPayloadContext) {
  const runtime = getLineRuntime();
  const outboundRuntime = await loadLineOutboundRuntime();
  const rawLineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};
  const lineData =
    rawLineData.card && !rawLineData.flexMessage
      ? { ...rawLineData, flexMessage: renderLineCard(rawLineData.card) }
      : rawLineData;
  const lineRuntime = runtime.channel.line;
  const location = lineData.location;
  const createFlex = outboundRuntime.createFlexMessage;
  const createLocation = outboundRuntime.createLocationMessage;
  const buildTemplate =
    lineRuntime?.buildTemplateMessageFromPayload ?? outboundRuntime.buildTemplateMessageFromPayload;
  const locationMessage = location ? createLocation(location) : null;

  const quickReplies = lineData.quickReplies ?? [];
  const quickReplyItems = lineData.quickReplyItems ?? [];
  const hasQuickReplies = quickReplies.length > 0 || quickReplyItems.length > 0;
  const quickReply = quickReplyItems.length
    ? createLineQuickReply(quickReplyItems)
    : quickReplies.length
      ? (lineRuntime?.createQuickReplyItems ?? outboundRuntime.createQuickReplyItems)(quickReplies)
      : undefined;
  const quickReplyLabels = quickReplyItems.length
    ? quickReplyItems.map((item) => item.label)
    : quickReplies;

  const plannedPushes: LineOutboundMessage[][] = [];
  const addPush = (messages: LineOutboundMessage[]): void => {
    if (messages.length > 0) {
      plannedPushes.push(messages);
    }
  };
  // LINE takes at most five messages per push.
  const addBatched = (messages: LineOutboundMessage[]): void => {
    for (let index = 0; index < messages.length; index += 5) {
      addPush(messages.slice(index, index + 5));
    }
  };
  const textWithQuickReply = (text: string): LineOutboundMessage[] =>
    quickReply ? [{ type: "text", text, quickReply }] : [{ type: "text", text }];

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
  const mediaUrls = resolveOutboundMediaUrls(payload).flatMap((url) => {
    const trimmed = url?.trim();
    return trimmed ? [trimmed] : [];
  });
  const mediaOptions = {
    mediaKind: lineData.mediaKind,
    previewImageUrl: lineData.previewImageUrl,
    durationMs: lineData.durationMs,
    trackingId: lineData.trackingId,
  };
  const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;
  const buildMediaMessages = async (): Promise<LineOutboundMessage[]> =>
    await Promise.all(mediaUrls.map((url) => buildLineMediaMessage(url, mediaOptions, to)));

  if (!shouldSendQuickRepliesInline) {
    if (lineData.flexMessage) {
      const flexContents = lineData.flexMessage.contents as messagingApi.FlexContainer;
      addPush([createFlex(lineData.flexMessage.altText, flexContents)]);
    }

    if (lineData.templateMessage) {
      const template = buildTemplate(lineData.templateMessage);
      if (template) {
        addPush([template]);
      }
    }

    if (locationMessage) {
      addPush([locationMessage]);
    }

    if (!orderedMessages) {
      for (const flexMsg of processed.flexMessages) {
        addPush([createFlex(flexMsg.altText, flexMsg.contents)]);
      }
    }
  }

  const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
  const mediaMessages =
    mediaUrls.length > 0 && !shouldSendQuickRepliesInline ? await buildMediaMessages() : [];
  if (!sendMediaAfterText) {
    for (const message of mediaMessages) {
      addPush([message]);
    }
  }

  if (orderedMessages && !shouldSendQuickRepliesInline) {
    for (const [index, message] of orderedMessages.entries()) {
      const isLast = index === orderedMessages.length - 1;
      if (message.type === "flex") {
        addPush(
          isLast && quickReply
            ? [{ ...message, quickReply }]
            : [createFlex(message.altText, message.contents)],
        );
      } else if (isLast && hasQuickReplies) {
        addPush(textWithQuickReply(message.text));
      } else {
        addPush([{ type: "text", text: message.text.trim() }]);
      }
    }
  } else if (chunks.length > 0) {
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      addPush(
        isLast && hasQuickReplies
          ? textWithQuickReply(chunk)
          : [{ type: "text", text: chunk.trim() }],
      );
    }
  } else if (shouldSendQuickRepliesInline) {
    const quickReplyMessages: LineOutboundMessage[] = [];
    if (lineData.flexMessage) {
      quickReplyMessages.push(
        createFlex(
          lineData.flexMessage.altText,
          lineData.flexMessage.contents as messagingApi.FlexContainer,
        ),
      );
    }
    if (lineData.templateMessage) {
      const template = buildTemplate(lineData.templateMessage);
      if (template) {
        quickReplyMessages.push(template);
      }
    }
    if (locationMessage) {
      quickReplyMessages.push(locationMessage);
    }
    for (const flexMsg of processed.flexMessages) {
      quickReplyMessages.push(createFlex(flexMsg.altText, flexMsg.contents));
    }
    quickReplyMessages.push(...(await buildMediaMessages()));
    if (quickReplyMessages.length > 0 && quickReply) {
      const lastIndex = quickReplyMessages.length - 1;
      quickReplyMessages[lastIndex] = {
        ...quickReplyMessages[lastIndex],
        quickReply,
      } as LineOutboundMessage;
      addBatched(quickReplyMessages);
    } else if (quickReply) {
      addPush(textWithQuickReply(buildLineQuickReplyFallbackText(quickReplyLabels)));
    }
  }

  if (sendMediaAfterText) {
    for (const message of mediaMessages) {
      addPush([message]);
    }
  }

  return await sendPlannedLinePushes(
    {
      to,
      cfg,
      accountId,
      replyToId,
      deliveryQueueId,
      deliveryPartIndex,
      deliveryPartCount,
      onPlatformSendDispatch,
      onDeliveryResult,
      assertDirectAdapterHandoff,
    },
    plannedPushes,
  );
}

async function sendPlannedLinePushes(
  {
    to,
    cfg,
    accountId,
    replyToId,
    deliveryQueueId,
    deliveryPartIndex,
    deliveryPartCount,
    onPlatformSendDispatch,
    onDeliveryResult,
    assertDirectAdapterHandoff,
  }: Pick<
    LineSendPayloadContext,
    | "to"
    | "cfg"
    | "accountId"
    | "replyToId"
    | "deliveryQueueId"
    | "deliveryPartIndex"
    | "deliveryPartCount"
    | "onPlatformSendDispatch"
    | "onDeliveryResult"
    | "assertDirectAdapterHandoff"
  >,
  plannedPushes: LineOutboundMessage[][],
) {
  if (plannedPushes.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  // LINE renders a quote on one bubble; quote before recording so a replay quotes too.
  const replyQuoteToken = resolveLineQuoteToken({
    cfg,
    accountId,
    chatId: to,
    messageId: replyToId,
  });
  const quotedPushIndex = replyQuoteToken
    ? plannedPushes.findIndex((messages) => messages.some(canCarryLineQuoteToken))
    : -1;
  if (replyQuoteToken && quotedPushIndex < 0) {
    reportLineQuoteCarrierMissing(to);
  }
  const quotedPushes = plannedPushes.map((messages, index) =>
    index === quotedPushIndex ? applyLineQuoteToken(messages, replyQuoteToken) : messages,
  );

  let pushes: { retryKey?: string; messages: LineOutboundMessage[] }[] = quotedPushes.map(
    (messages) => ({ messages }),
  );
  if (deliveryQueueId) {
    const keyedPushes = quotedPushes.map((messages, pushIndex) => ({
      retryKey: resolveLinePushRetryKey({
        deliveryQueueId,
        partIndex: deliveryPartIndex ?? 0,
        pushIndex,
      }),
      messages: messages.map(normalizeLineMessage),
    }));
    try {
      pushes = (
        await recordLineDurableSendPlan({
          queueId: deliveryQueueId,
          partIndex: deliveryPartIndex,
          partCount: deliveryPartCount,
          to,
          ...(accountId ? { accountId } : {}),
          pushes: keyedPushes,
        })
      ).pushes;
    } catch (error) {
      // Nothing has reached LINE yet, so core may retry or retire the row safely.
      throw new PlatformMessageNotDispatchedError(formatErrorMessage(error), {
        cause: error,
        retryable: !(error instanceof LineDurableSendPlanError),
      });
    }
  }
  return await dispatchLinePushes({
    to,
    cfg,
    accountId,
    onPlatformSendDispatch,
    onDeliveryResult,
    assertDirectAdapterHandoff,
    pushes,
  });
}

/** Sends one part's pushes in order; with recorded keys this is also the replay path. */
async function dispatchLinePushes(params: {
  to: string;
  cfg: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]>["sendPayload"]>
  >[0]["cfg"];
  accountId?: string | null;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: (result: OutboundDeliveryResult) => void | Promise<void>;
  assertDirectAdapterHandoff?: () => void;
  pushes: readonly { retryKey?: string; messages: LineOutboundMessage[] }[];
  retryKeyExpiresAtMs?: number;
}): Promise<OutboundDeliveryResult> {
  const runtime = getLineRuntime();
  const outboundRuntime = await loadLineOutboundRuntime();
  const sendBatch = runtime.channel.line?.pushMessagesLine ?? outboundRuntime.pushMessagesLine;
  const dispatchOnce = params.onPlatformSendDispatch
    ? createDispatchOnce(params.onPlatformSendDispatch)
    : undefined;
  const accountId = params.accountId ?? undefined;
  const { assertDirectAdapterHandoff } = params;
  const authorize = assertDirectAdapterHandoff
    ? () => {
        assertDirectAdapterHandoff();
        return true;
      }
    : undefined;
  let lastResult: LineSendResult | null = null;
  for (const push of params.pushes) {
    let result: LineSendResult;
    try {
      result = await sendBatch(params.to, push.messages, {
        verbose: false,
        cfg: params.cfg,
        accountId,
        authorize,
        ...(dispatchOnce ? { onPlatformSendDispatch: dispatchOnce } : {}),
        ...(push.retryKey ? { durableRetryKey: push.retryKey } : {}),
        ...(params.retryKeyExpiresAtMs === undefined
          ? {}
          : { retryKeyExpiresAtMs: params.retryKeyExpiresAtMs }),
      });
    } catch (error) {
      // Accepted pushes keep their receipt and must not wait for quota diagnosis.
      const refusal =
        lastResult !== null || isChannelPartialDeliveryError(error)
          ? undefined
          : await explainLineRefusal({ error, cfg: params.cfg, accountId });
      throw refusal?.retryable !== undefined
        ? new PlatformMessageNotDispatchedError(refusal.reason, {
            cause: error,
            retryable: refusal.retryable,
          })
        : error;
    }
    lastResult = result;
    try {
      await params.onDeliveryResult?.(createEmptyChannelResult("line", { ...result }));
    } catch (error) {
      // Observers run after provider acceptance; losing this receipt invites duplicate delivery.
      throw createChannelPartialDeliveryError(error, {
        messageIds: listMessageReceiptPlatformIds(result.receipt),
        receipt: result.receipt,
        visibleReplySent: true,
      });
    }
  }
  if (!lastResult) {
    throw new Error("Message must be non-empty for LINE sends");
  }
  return createEmptyChannelResult("line", { ...lastResult });
}

export const lineOutboundAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]> = {
  deliveryMode: "direct",
  chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
  textChunkLimit: 5000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  presentationCapabilities: LINE_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation, sourcePresentation, ctx }) =>
    renderLinePresentation(payload, presentation, ctx.to, sourcePresentation),
  // Core plans no parts for a structured payload; it is one part of one.
  sendPayload: async (ctx) =>
    await sendLinePayload({
      ...ctx,
      deliveryPartIndex: ctx.deliveryPartIndex ?? 0,
      deliveryPartCount: ctx.deliveryPartCount ?? 1,
    }),
  ...createAttachedChannelResultAdapter({
    channel: "line",
    // The payload owner records each physical send before the next fallible step;
    // bypassing it fabricates Flex-only ids and loses partial-delivery evidence.
    sendText: async (ctx) =>
      await sendLinePayload({
        ...ctx,
        payload: { text: ctx.text },
      }),
    // Keeps main's shape for a direct media send: media and caption in one push.
    sendMedia: async (ctx) => {
      const url = ctx.mediaUrl?.trim();
      const caption = ctx.text?.trim();
      const messages: LineOutboundMessage[] = [
        ...(url ? [await buildLineMediaMessage(url, {}, ctx.to)] : []),
        ...(caption ? [{ type: "text" as const, text: caption }] : []),
      ];
      return await sendPlannedLinePushes(ctx, messages.length > 0 ? [messages] : []);
    },
  }),
};

/**
 * LINE has no "was this accepted?" endpoint, so reconciliation reissues the recorded
 * requests under their original retry keys: an accepted push answers 409 with its
 * receipt, and one that never landed is delivered now.
 */
async function reconcileLineUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  let plans: Awaited<ReturnType<typeof loadLineDurableSendPlans>>;
  try {
    plans = await loadLineDurableSendPlans(ctx.queueId);
  } catch (error) {
    return {
      status: "unresolved",
      error: formatErrorMessage(error),
      retryable: !(error instanceof LineDurableSendPlanError),
    };
  }
  const firstDispatchedAtMs = plans.length
    ? Math.min(...plans.map((plan) => plan.firstDispatchedAtMs))
    : undefined;
  const retryKeyExpiresAtMs =
    firstDispatchedAtMs === undefined ? undefined : firstDispatchedAtMs + LINE_RETRY_KEY_TTL_MS;
  if (retryKeyExpiresAtMs !== undefined && Date.now() >= retryKeyExpiresAtMs) {
    // LINE forgets a retry key after 24 hours, so a replay would deliver a second copy.
    return {
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    };
  }
  if (plans.length === 0) {
    // The plan is written before the dispatch marker, so no record means the send went
    // out under random retry keys (core withheld the queue id) and cannot be replayed.
    return {
      status: "unresolved",
      error: "LINE delivery carried no durable record, so a replay could not be deduplicated",
      retryable: false,
    };
  }
  // The receipt must name every push, not only the last one each part returns.
  const results: OutboundDeliveryResult[] = [];
  for (const plan of plans) {
    try {
      await dispatchLinePushes({
        cfg: ctx.cfg,
        to: plan.to,
        ...(plan.accountId === undefined ? {} : { accountId: plan.accountId }),
        pushes: plan.pushes,
        retryKeyExpiresAtMs,
        onDeliveryResult: (result) => {
          results.push(result);
        },
      });
    } catch (error) {
      if (isLineRetryKeyExpiredError(error)) {
        return {
          status: "unresolved",
          error: "LINE retry key expired before the queued send could be reconciled",
          retryable: false,
        };
      }
      const nonDispatchRetryable = resolveLineNonDispatchRetryable(error);
      if (results.length === 0 && nonDispatchRetryable === false && isLineRequestRejection(error)) {
        // A 400 refuses these exact bytes, so the interrupted attempt was refused too;
        // a 401/403 only refuses today's credentials and stays unresolved.
        return { status: "not_sent" };
      }
      return {
        status: "unresolved",
        error: formatErrorMessage(error),
        retryable: nonDispatchRetryable ?? true,
      };
    }
  }
  const receipt = createMessageReceiptFromOutboundResults({
    results,
    ...(ctx.threadId == null ? {} : { threadId: String(ctx.threadId) }),
    ...(ctx.effectiveReplyToId ? { replyToId: ctx.effectiveReplyToId } : {}),
  });
  return {
    status: "sent",
    ...(receipt.primaryPlatformMessageId ? { messageId: receipt.primaryPlatformMessageId } : {}),
    receipt,
  };
}

// The bridge forwards the whole send context, including the durable-send seam.
const lineMessageAdapterBase = createChannelMessageAdapterFromOutbound({
  id: "line",
  // `message send --media` keeps main's shape: caption, then media, as two pushes.
  outbound: {
    ...lineOutboundAdapter,
    sendMedia: async (ctx) =>
      await sendLinePayload({ ...ctx, payload: { text: ctx.text, mediaUrl: ctx.mediaUrl } }),
  },
  capabilities: {
    text: true,
    media: true,
    // Core withholds durable final delivery from any payload whose declared
    // capabilities it cannot find, so a reply that names a target has to say so.
    replyTo: true,
    payload: true,
    messageSendingHooks: true,
    reconcileUnknownSend: true,
  },
  receive: {
    defaultAckPolicy: "after_receive_record",
    supportedAckPolicies: ["after_receive_record"],
  },
});

export const lineMessageAdapter = defineChannelMessageAdapter({
  ...lineMessageAdapterBase,
  durableFinal: {
    ...lineMessageAdapterBase.durableFinal,
    // Every queued LINE send is recorded, so reconcile without each caller opting in.
    automaticUnknownSendReconciliation: true,
    capabilities: { ...lineMessageAdapterBase.durableFinal?.capabilities, afterCommit: true },
    reconcileUnknownSendKinds: { text: true, media: true, payload: true },
    reconcileUnknownSend: reconcileLineUnknownSend,
    afterUnknownSendTerminal: async (ctx) => await clearLineDurableSendPlans(ctx.queueId),
  },
  send: {
    ...lineMessageAdapterBase.send,
    lifecycle: {
      afterCommit: async (ctx) => {
        if (ctx.deliveryQueueId) {
          await clearLineDurableSendPlans(ctx.deliveryQueueId);
        }
      },
    },
  },
});
