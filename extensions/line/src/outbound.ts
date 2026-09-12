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
  LineDurableSendPlanStoreError,
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

/** Any LINE message this adapter can put on the wire. */
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

/**
 * Renders one delivery part into the exact pushes it will make, records them all
 * before the first of them leaves, then sends them.
 *
 * No LINE message in a part depends on the result of an earlier one, so the whole
 * fan-out is known before any of it is sent. Recording it whole is what lets a
 * replay reissue the very requests LINE was asked to take, instead of re-rendering
 * the reply and hoping it still renders the same way.
 */
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

  // Every entry is one push, in the order it will be made. Nothing is sent while
  // this is being built, so a failure here — an unusable media URL, for instance —
  // refuses the whole reply instead of leaving half of it delivered.
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
    },
    plannedPushes,
  );
}

/**
 * Quotes, records and sends one part's planned pushes. Every route that sends a part
 * comes through here, so a replay always finds the request that actually went out.
 */
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
  >,
  plannedPushes: LineOutboundMessage[][],
) {
  if (plannedPushes.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  // LINE renders a quote on one bubble, so a reply spends its token on the first
  // message able to carry it, whichever push that is. Quoting before the plan is
  // recorded is what lets a replay reissue the quote along with the request.
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
    pushes = keyedPushes;
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
      if (!(error instanceof LineDurableSendPlanStoreError)) {
        throw error;
      }
      // The plan is crash evidence, not the delivery: a store that will not take it
      // costs this part its recovery, never its reply, as a best-effort queue row does in
      // core (`deliver-queue.ts`). The derived keys still let LINE deduplicate a retry;
      // only a crash before the send settles is left unresolved instead of replayed.
      getLineRuntime()
        .logging.getChildLogger({ plugin: "line", feature: "durable-send" })
        .warn(`${error.message} (delivery ${deliveryQueueId}); sending it without crash recovery`);
    }
  }
  return await dispatchLinePushes({
    to,
    cfg,
    accountId,
    onPlatformSendDispatch,
    onDeliveryResult,
    pushes,
  });
}

/**
 * Sends the pushes of one part, in order, under the keys they were recorded with.
 *
 * A recorded key makes each request idempotent for LINE's 24-hour window, so this
 * is also the replay path: reissuing an accepted push answers 409 with its original
 * receipt, and one that never landed is delivered now.
 */
async function dispatchLinePushes(params: {
  to: string;
  cfg: Parameters<
    NonNullable<NonNullable<ChannelPlugin<ResolvedLineAccount>["outbound"]>["sendPayload"]>
  >[0]["cfg"];
  accountId?: string | null;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: (result: OutboundDeliveryResult) => void | Promise<void>;
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
  let lastResult: LineSendResult | null = null;
  for (const push of params.pushes) {
    let result: LineSendResult;
    try {
      result = await sendBatch(params.to, push.messages, {
        verbose: false,
        cfg: params.cfg,
        accountId,
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
  // Core plans parts for text and media but not for a structured payload, because a
  // payload is one part of one; it is stated here rather than substituted at the
  // recorder, which must keep refusing a route that lost its real coordinates.
  // Matrix's adapter draws the same line in the same place.
  sendPayload: async (ctx) =>
    await sendLinePayload({
      ...ctx,
      // Present and undefined on this route (`deliver-channel.ts`), so spreading a
      // default under it would be overwritten by the absent value.
      deliveryPartIndex: ctx.deliveryPartIndex ?? 0,
      deliveryPartCount: ctx.deliveryPartCount ?? 1,
    }),
  ...createAttachedChannelResultAdapter({
    channel: "line",
    // The payload owner records each physical send before the next fallible step;
    // bypassing it fabricates Flex-only ids and loses partial-delivery evidence.
    // These two keep the coordinates core planned for them.
    sendText: async (ctx) =>
      await sendLinePayload({
        ...ctx,
        payload: { text: ctx.text },
      }),
    // A direct media send keeps the request `sendMessageLine` made: the media and its
    // caption in one push, recorded as one so a replay reissues it whole.
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
 * LINE has no read-only "was this accepted?" endpoint, so reconciliation reissues
 * the requests the interrupted send recorded, under the very keys it used: a push
 * LINE already accepted answers 409 with its original receipt, and one that never
 * landed is delivered now. The reply is not rendered or normalized again: the recorded
 * messages go back out as stored, so a reply that would render differently today still
 * resolves as the one LINE was actually asked to take.
 */
async function reconcileLineUnknownSend(
  ctx: ChannelMessageUnknownSendContext,
): Promise<ChannelMessageUnknownSendReconciliationResult> {
  // `platformSendStartedAt` is refreshed on every dispatch
  // (`markDeliveryPlatformSendDispatched`), so it answers "when did the latest attempt
  // start", not "when did LINE first see these keys". It is only good enough to reject
  // a delivery that is already past the window before any record is read; the
  // authoritative instant comes off the recorded plan below.
  const sendStartedAt = ctx.platformSendStartedAt ?? ctx.enqueuedAt;
  if (Date.now() - sendStartedAt >= LINE_RETRY_KEY_TTL_MS) {
    // LINE forgets a retry key after 24 hours, so a replay would deliver a second copy.
    return {
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    };
  }
  let plans: Awaited<ReturnType<typeof loadLineDurableSendPlans>>;
  try {
    plans = await loadLineDurableSendPlans(ctx.queueId);
  } catch (error) {
    // Incomplete evidence is fail-closed on purpose: replaying part of a record
    // would either duplicate an accepted push or drop one LINE never received.
    return {
      status: "unresolved",
      error: formatErrorMessage(error),
      retryable: !(error instanceof LineDurableSendPlanError),
    };
  }
  // Every part of one delivery is dispatched together, so the earliest recorded
  // instant is when this delivery's keys first reached LINE.
  const firstDispatchedAtMs = plans.length
    ? Math.min(...plans.map((plan) => plan.firstDispatchedAtMs))
    : undefined;
  const retryKeyExpiresAtMs =
    firstDispatchedAtMs === undefined ? undefined : firstDispatchedAtMs + LINE_RETRY_KEY_TTL_MS;
  if (retryKeyExpiresAtMs !== undefined && Date.now() >= retryKeyExpiresAtMs) {
    // The recorded instant is older than the queue entry knew, so this is the first
    // point that can tell the window has actually closed.
    return {
      status: "unresolved",
      error: "LINE retry key expired before the queued send could be reconciled",
      retryable: false,
    };
  }
  if (plans.length === 0) {
    // A push records itself before the dispatch marker that brings a delivery
    // here at all (send.ts), so an empty record does not mean nothing was sent:
    // it means this delivery never carried a recorder. Core withholds the queue
    // id from a send it cannot key one-to-one — a batch, or one needing a
    // capability this adapter does not declare — and those pushes went out under
    // keys LINE will not deduplicate, so replaying them would deliver a second
    // copy. Refuse instead.
    return {
      status: "unresolved",
      error: "LINE delivery carried no durable record, so a replay could not be deduplicated",
      retryable: false,
    };
  }
  // One payload can fan out into several platform sends, and the settled queue
  // entry must carry the identity of every one of them. Collecting per push is
  // what the live path does through this same observer; the payload's return
  // value only carries its final send. Nothing is re-rendered here: the recorded
  // requests are reissued exactly, so a reply that would render differently now
  // still resolves as the one LINE was asked to take.
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
      // Reuses the send owner's classification rather than re-reading the status
      // here: it is the one place that knows a 429 stays retryable, a 408 stays
      // ambiguous, and a retry-key 409 is an accepted delivery, not a refusal.
      if (isLineRetryKeyExpiredError(error)) {
        // Same outcome the entry guard reports, because it is the same condition:
        // the key stopped being deduplicated, so no further attempt is safe and the
        // delivery cannot be settled either way.
        return {
          status: "unresolved",
          error: "LINE retry key expired before the queued send could be reconciled",
          retryable: false,
        };
      }
      const nonDispatchRetryable = resolveLineNonDispatchRetryable(error);
      if (results.length === 0 && nonDispatchRetryable === false && isLineRequestRejection(error)) {
        // LINE rejected this exact request, so the interrupted attempt carrying the same
        // bytes was rejected too. A credential refusal proves only that today's replay
        // failed, so it stays unresolved below.
        return { status: "not_sent" };
      }
      return {
        status: "unresolved",
        error: formatErrorMessage(error),
        // An ambiguous failure stays retryable: the derived retry key makes a
        // replay safe for 24 hours even if the interrupted attempt did land.
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

// The bridge forwards the send context verbatim. Rebuilding it by hand drops the
// durable send seam core installed there, and an adapter that never reports its
// platform dispatch cannot be reconciled after a crash.
const lineMessageAdapterBase = createChannelMessageAdapterFromOutbound({
  id: "line",
  // `message send --media` comes through the message adapter, where main sent the
  // caption and the media the way the payload owner does: separately, caption first.
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
    // Every queued LINE send records its pushes, so reconciliation is not limited to
    // callers that ask for it: without this, an ordinary send that crashes mid-flight
    // is dead-lettered even though the record needed to resolve it is already on disk.
    // Declaring it here is also why no caller has to require it as a capability, which
    // would raise durability to `required` and turn a failed queue write from a reply
    // still delivered live into no reply at all.
    automaticUnknownSendReconciliation: true,
    capabilities: { ...lineMessageAdapterBase.durableFinal?.capabilities, afterCommit: true },
    // Every platform send inside one payload carries its own durable key, so a
    // replay resolves each push independently instead of resending the batch.
    reconcileUnknownSendKinds: { text: true, media: true, payload: true },
    reconcileUnknownSend: reconcileLineUnknownSend,
    afterUnknownSendTerminal: async (ctx) => await clearLineDurableSendPlans(ctx.queueId),
  },
  send: {
    ...lineMessageAdapterBase.send,
    lifecycle: {
      // Recorded requests exist only to answer a replay. Once the delivery is
      // committed no replay can need them, so the content does not linger.
      afterCommit: async (ctx) => {
        if (ctx.deliveryQueueId) {
          await clearLineDurableSendPlans(ctx.deliveryQueueId);
        }
      },
    },
  },
});
