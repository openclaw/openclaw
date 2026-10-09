import {
  createChannelProgressDraftCompositor,
  resolveChannelPreviewStreamMode,
} from "openclaw/plugin-sdk/channel-outbound";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MarkdownTableMode, MSTeamsConfig, ReplyPayload } from "../runtime-api.js";
import { formatMSTeamsMarkdown } from "./format.js";
import { extractMessageId } from "./media-helpers.js";
import { buildMSTeamsMessageActivity } from "./message-activity.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type TeamsStreamChunkActivity = {
  id?: string;
  type?: string;
  text?: string;
  channelData?: { streamType?: string };
};

type TeamsStreamChunkEvents = {
  on(event: "chunk", handler: (activity: TeamsStreamChunkActivity) => void): number;
  off(subscriptionId: number): void;
};

type MSTeamsNativeDeliveryFinalization = {
  visibleReplySent: boolean;
  content?: string;
  logicalContent?: string;
  messageId?: string;
  fallbackPayload?: ReplyPayload;
  postNativePayloads?: ReplyPayload[];
};

// The SDK throws StreamCancelledError synchronously from stream.emit/update
// when the user pressed Stop in Teams (Teams replies 403 to the next chunk
// update and the SDK flips _canceled). Match by `name` rather than importing
// the class — tsgo can't resolve the re-export chain through
// @microsoft/teams.apps/dist/types/streamer, and the SDK's own code at
// utils/promises/retry.js falls back to this same name check.
function isStreamCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === "StreamCancelledError";
}

/** Bridge reply callbacks to the SDK stream; shared conversations use block delivery. */
export function createTeamsReplyStreamController(params: {
  allowProviderPreview: boolean;
  conversationType?: string;
  context: MSTeamsTurnContext;
  feedbackLoopEnabled: boolean;
  log?: MSTeamsMonitorLogger;
  msteamsConfig?: MSTeamsConfig;
  tableMode?: MarkdownTableMode;
  /** Stable label rotation across reconnects, typically `${accountId}:${convId}`. */
  progressSeed?: string;
}) {
  const isPersonal = normalizeOptionalLowercaseString(params.conversationType) === "personal";
  const streamMode = resolveChannelPreviewStreamMode(params.msteamsConfig, "partial");
  const shouldUseNativeStream =
    params.allowProviderPreview &&
    isPersonal &&
    (streamMode === "partial" || streamMode === "progress");
  const stream = shouldUseNativeStream ? params.context.stream : undefined;

  let tokensEmitted = false;
  let nativeDispatchStarted = false;
  let nativeDeliveryClaimed = false;
  let streamFinalizationPending = false;
  let canceledLocally = false;
  // Provider failures allow block fallback; user cancellation suppresses it.
  let streamFailed = false;
  let pendingFinalPayload: ReplyPayload | undefined;
  // The SDK appends deltas to cumulative pipeline text. Retain the text, not just
  // its length, because later snapshots can normalize trailing whitespace.
  let emittedText = "";
  let acknowledgedText = "";
  let acknowledgedLogicalText = "";
  let acknowledgedStreamId: string | undefined;
  let replacementFinalPending = false;
  let replacementEmitFailed = false;
  let replacementSettlementPending = false;
  let replacementTextAwaitingAcknowledgement: { text: string; logicalText: string } | undefined;
  let deferredReplacementEntries: { kind: "payload" | "replacement"; payload: ReplyPayload }[] = [];
  let queuedFinalActivity: ReturnType<typeof finalStreamActivity> | undefined;
  let failedSegmentFallbackPrepared = false;
  const streamEvents = (stream as { events?: TeamsStreamChunkEvents } | undefined)?.events;
  let streamChunkSubscription: number | undefined;

  // The SDK emits `chunk` only after Teams acknowledges a cumulative typing
  // activity. Never infer delivered text from emit(), queued bytes, or errors.
  if (typeof streamEvents?.on === "function" && typeof streamEvents.off === "function") {
    streamChunkSubscription = streamEvents.on("chunk", (activity) => {
      const replacementAcknowledgementPending =
        replacementTextAwaitingAcknowledgement !== undefined;
      const replacementAcknowledgement =
        typeof activity.text === "string" &&
        replacementAcknowledgementPending &&
        activity.text === replacementTextAwaitingAcknowledgement?.text;
      if (
        activity.type !== "typing" ||
        activity.channelData?.streamType !== "streaming" ||
        !activity.id ||
        !activity.text ||
        (acknowledgedStreamId !== undefined && activity.id !== acknowledgedStreamId) ||
        (replacementAcknowledgementPending
          ? !replacementAcknowledgement
          : !activity.text.startsWith(acknowledgedText)) ||
        (!replacementAcknowledgement && !emittedText.startsWith(activity.text))
      ) {
        return;
      }
      acknowledgedStreamId = activity.id;
      acknowledgedText = activity.text;
      acknowledgedLogicalText = replacementAcknowledgement
        ? replacementTextAwaitingAcknowledgement!.logicalText
        : activity.text;
      if (replacementAcknowledgement) {
        replacementTextAwaitingAcknowledgement = undefined;
      }
    });
  }

  const wasCanceled = () => canceledLocally || Boolean(stream?.canceled);

  const releaseStreamChunkSubscription = (): void => {
    if (streamChunkSubscription === undefined) {
      return;
    }
    streamEvents?.off(streamChunkSubscription);
    streamChunkSubscription = undefined;
  };

  const acknowledgedNativeDelivery = (): MSTeamsNativeDeliveryFinalization => {
    if (!acknowledgedStreamId || !acknowledgedText) {
      return { visibleReplySent: false };
    }
    return {
      visibleReplySent: true,
      content: acknowledgedText,
      messageId: acknowledgedStreamId,
    };
  };

  const fallbackPayloadAfterAcknowledgedText = (
    payload: ReplyPayload,
  ): ReplyPayload | undefined => {
    if (
      !acknowledgedLogicalText ||
      typeof payload.text !== "string" ||
      !payload.text.startsWith(acknowledgedLogicalText)
    ) {
      return payload;
    }
    const remainingText = payload.text.slice(acknowledgedLogicalText.length);
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
    if (!remainingText && !hasMedia) {
      return undefined;
    }
    return { ...payload, text: remainingText || undefined };
  };

  const fallbackPayloadForSuppressedFinal = (payload: ReplyPayload): ReplyPayload => {
    const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
    return hasMedia ? { ...payload, mediaUrl: undefined, mediaUrls: undefined } : payload;
  };

  const finalStreamActivity = (text?: string) => ({
    ...buildMSTeamsMessageActivity(
      text === undefined ? undefined : formatMSTeamsMarkdown(text, params.tableMode ?? "code"),
    ),
    channelData: params.feedbackLoopEnabled ? { feedbackLoopEnabled: true } : {},
  });

  const deferredReplacementLogicalContent = (): string | undefined => {
    const content = deferredReplacementEntries
      .map((entry) => entry.payload.text)
      .filter((text): text is string => Boolean(text))
      .join("\n");
    return content || undefined;
  };

  const deferredReplacementPayloads = (
    replacementFallback: ReplyPayload | undefined,
  ): ReplyPayload[] =>
    deferredReplacementEntries.flatMap((entry) => {
      if (entry.kind === "payload") {
        return [entry.payload];
      }
      const hasMedia = Boolean(entry.payload.mediaUrl || entry.payload.mediaUrls?.length);
      const text = replacementFallback?.text;
      if (!text && !hasMedia) {
        return [];
      }
      return [{ ...entry.payload, text: text || undefined }];
    });

  const finalizeWithoutReceipt = (
    logicalContent?: string,
    canceled = false,
  ): MSTeamsNativeDeliveryFinalization => {
    const fallback =
      pendingFinalPayload && !canceled
        ? fallbackPayloadAfterAcknowledgedText(pendingFinalPayload)
        : undefined;
    const postNativePayloads =
      replacementSettlementPending && !canceled ? deferredReplacementPayloads(fallback) : [];
    return {
      ...acknowledgedNativeDelivery(),
      ...(!canceled && logicalContent ? { logicalContent } : {}),
      ...(!replacementSettlementPending && fallback ? { fallbackPayload: fallback } : {}),
      ...(postNativePayloads.length > 0 ? { postNativePayloads } : {}),
    };
  };

  // Teams cannot delete an empty interim card; final delivery settles it.
  const progressDraft = createChannelProgressDraftCompositor({
    preparedItems: true,
    // Informative Teams activities are already plain text, unlike Markdown draft transports.
    formatPlainText: (text) => text,
    entry: params.msteamsConfig,
    mode: streamMode,
    active: Boolean(stream) && streamMode === "progress",
    seed: params.progressSeed ?? "msteams",
    update: (text) => {
      if (!stream || wasCanceled() || streamFinalizationPending) {
        return false;
      }
      try {
        stream.update(text.replace(/^• /gmu, "- "));
        return true;
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
        } else {
          params.log?.debug?.(`stream informative update failed: ${coerceErrorMessage(err)}`);
        }
        return false;
      }
    },
  });

  return {
    onPartialReply(payload: { text?: string }): void {
      // Partial-token streaming only fires in "partial" mode. Progress-mode
      // final payloads arrive at preparePayload instead.
      if (!stream || !payload.text || wasCanceled() || streamMode !== "partial") {
        return;
      }
      if (replacementSettlementPending && replacementFinalPending) {
        // Keep the newest partial as the replacement candidate until the
        // authoritative final payload arrives. Never append it into the SDK
        // accumulator that clearText() reset.
        pendingFinalPayload = { text: payload.text };
        return;
      }
      // Closing the first segment does not grant another native delivery claim.
      if (streamFinalizationPending || nativeDeliveryClaimed) {
        return;
      }
      // Convert cumulative-text from the pipeline into deltas for the SDK's
      // appending sink. Without this, "Here's a" → "Here's a sonnet" → ...
      // gets emitted as full repeats and the SDK concatenates the lot.
      const fullText = payload.text;
      let prefixLength = 0;
      while (
        prefixLength < emittedText.length &&
        prefixLength < fullText.length &&
        emittedText[prefixLength] === fullText[prefixLength]
      ) {
        prefixLength += 1;
      }
      const previousRemainder = emittedText.slice(prefixLength);
      const delta = fullText.slice(prefixLength);
      // Duplicate or prefix-only out-of-order snapshots produce no delta.
      if (!delta) {
        return;
      }
      // Non-whitespace rewrites are not safe to append into Teams. Clear the
      // SDK's local accumulator, then replace the same streamed activity with
      // the authoritative final so a late provider Stop is still observed.
      if (previousRemainder.trim()) {
        stream.clearText();
        if (streamFailed) {
          // A prior provider failure already transferred this and later
          // segments to block delivery. Preserve the pending close cleanup,
          // but do not retry final text through a failed native stream.
          streamFinalizationPending = true;
          return;
        }
        // The SDK can replace the same streamed activity after clearText().
        // Defer the authoritative final to preparePayload so this provider
        // round-trip also discovers a Stop before any fallback can escape.
        replacementFinalPending = true;
        replacementSettlementPending = true;
        pendingFinalPayload = { text: fullText };
        streamFinalizationPending = true;
        return;
      }
      try {
        stream.emit(delta);
        emittedText = fullText;
        tokensEmitted = true;
        nativeDispatchStarted = true;
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return;
        }
        // Preserve full fallback unless the SDK has proved exactly which
        // cumulative prefix Teams accepted; failed emits prove no delivery.
        streamFailed = true;
        params.log?.warn?.(
          `msteams stream emit failed, falling back to block delivery: ${coerceErrorMessage(err)}`,
        );
      }
    },

    pushItemEvent: progressDraft.pushItemEvent.bind(progressDraft),
    pushToolEvent: progressDraft.pushToolEvent,

    pushReasoningProgress: progressDraft.pushReasoningProgress.bind(progressDraft),
    resetReasoningProgress: progressDraft.resetReasoningProgress,
    pushApprovalEvent: progressDraft.pushApprovalEvent.bind(progressDraft),
    pushPlanProgress: progressDraft.pushPlanProgress.bind(progressDraft),

    preparePayload(payload: ReplyPayload): ReplyPayload | undefined {
      if (!stream) {
        return payload;
      }
      // User pressed Stop (or Teams ended the stream) — the streamed prefix
      // is already visible to the user. Dropping the payload here prevents a
      // second block message from re-delivering the rest, which would override
      // the explicit cancel intent.
      if (wasCanceled()) {
        return undefined;
      }
      if (payload.text) {
        progressDraft.markFinalReplyStarted();
      }
      if (replacementSettlementPending) {
        if (!replacementFinalPending || !payload.text) {
          // The native stream activity was created before final payloads and
          // remains the provider-visible root. Preserve deferred block order
          // after that root; sending early would leak content after Stop.
          deferredReplacementEntries.push({ kind: "payload", payload });
          return undefined;
        }
        replacementFinalPending = false;
        deferredReplacementEntries.push({ kind: "replacement", payload });
        pendingFinalPayload = fallbackPayloadForSuppressedFinal(payload);
        try {
          const activity = finalStreamActivity(payload.text);
          replacementTextAwaitingAcknowledgement = {
            text: activity.text!,
            logicalText: payload.text,
          };
          stream.emit(activity);
          queuedFinalActivity = activity;
          emittedText = payload.text;
          tokensEmitted = false;
          // Replacement delivery owns all later payloads until close() proves
          // that Teams accepted the replacement or did not receive a Stop.
          return undefined;
        } catch (err) {
          replacementTextAwaitingAcknowledgement = undefined;
          tokensEmitted = false;
          if (isStreamCancelledError(err)) {
            canceledLocally = true;
            pendingFinalPayload = undefined;
            deferredReplacementEntries = [];
            return undefined;
          }
          streamFailed = true;
          replacementEmitFailed = true;
          params.log?.warn?.(
            `msteams stream replacement failed, falling back to block delivery: ${coerceErrorMessage(err)}`,
          );
          // Retain ownership until finalize so payloads held before this
          // failed replacement cannot be overtaken by this or later blocks.
          return undefined;
        }
      }
      if (streamFailed) {
        // Trim the provider-acknowledged prefix only from the failed segment.
        // Retain its ID/text for final settlement while later tool rounds fall through whole.
        const fallback = failedSegmentFallbackPrepared
          ? payload
          : fallbackPayloadAfterAcknowledgedText(payload);
        failedSegmentFallbackPrepared = true;
        pendingFinalPayload = undefined;
        return fallback;
      }
      // A native stream owns one final segment. Later progress payloads use
      // block delivery, just like later partial-mode segments after tools.
      if (streamMode === "progress" && payload.text && !nativeDispatchStarted) {
        try {
          stream.emit(payload.text);
          emittedText = payload.text;
          nativeDispatchStarted = true;
          tokensEmitted = true;
        } catch (err) {
          if (isStreamCancelledError(err)) {
            canceledLocally = true;
            return undefined;
          }
          // Non-cancel emit failure: fall through to block delivery as a
          // safety net so the user still sees the final reply.
          params.log?.debug?.(`progress-mode finalize failed: ${coerceErrorMessage(err)}`);
        }
      }
      if (tokensEmitted) {
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        pendingFinalPayload = fallbackPayloadForSuppressedFinal(payload);
        streamFinalizationPending = true;
        tokensEmitted = false;
        return hasMedia ? { ...payload, text: undefined } : undefined;
      }
      return payload;
    },

    claimNativeDelivery(): boolean {
      if (!nativeDispatchStarted || nativeDeliveryClaimed) {
        return false;
      }
      nativeDeliveryClaimed = true;
      return true;
    },

    async finalize(): Promise<MSTeamsNativeDeliveryFinalization> {
      // The SDK reopens closed streams on update; retire progress before close.
      progressDraft.markFinalReplyStarted();
      if (!stream || !nativeDispatchStarted) {
        releaseStreamChunkSubscription();
        return { visibleReplySent: false };
      }
      let logicalContent: string | undefined;
      try {
        if (wasCanceled() || !streamFinalizationPending) {
          return acknowledgedNativeDelivery();
        }
        // A media-only replacement payload may arrive before its text payload.
        // If no authoritative text followed, re-emit the latest divergent
        // partial so close() still performs the Stop-discovering round-trip.
        if (replacementSettlementPending && replacementFinalPending && pendingFinalPayload?.text) {
          replacementFinalPending = false;
          deferredReplacementEntries.push({
            kind: "replacement",
            payload: pendingFinalPayload,
          });
          const activity = finalStreamActivity(pendingFinalPayload.text);
          replacementTextAwaitingAcknowledgement = {
            text: activity.text!,
            logicalText: pendingFinalPayload.text,
          };
          logicalContent = deferredReplacementLogicalContent();
          stream.emit(activity);
          queuedFinalActivity = activity;
          emittedText = pendingFinalPayload.text;
        }
        logicalContent ??= replacementSettlementPending
          ? deferredReplacementLogicalContent()
          : undefined;
        const logicalText = pendingFinalPayload?.text ?? (emittedText || undefined);
        const finalActivity = queuedFinalActivity ?? finalStreamActivity(logicalText);
        const content = finalActivity.text;
        logicalContent ??= content !== logicalText ? logicalText : undefined;
        // The replacement path already queued text and final metadata as one
        // activity. Other paths add metadata here so the SDK can merge it into
        // the closing activity without duplicating the replacement chunk.
        if (!queuedFinalActivity) {
          if (content !== undefined && content !== emittedText) {
            // The SDK appends text. Replace its buffer once the complete Markdown
            // is known; retain logical text separately for acknowledged fallback.
            stream.clearText();
            replacementTextAwaitingAcknowledgement = { text: content, logicalText: logicalText! };
            stream.emit(finalActivity);
          } else {
            stream.emit({ ...finalActivity, text: undefined });
          }
        }
        const result = await stream.close();
        if (!result) {
          return finalizeWithoutReceipt(logicalContent, wasCanceled());
        }
        const replacementFallback =
          replacementSettlementPending && replacementEmitFailed && pendingFinalPayload
            ? fallbackPayloadAfterAcknowledgedText(pendingFinalPayload)
            : undefined;
        const messageId = extractMessageId(result) ?? acknowledgedStreamId;
        const postNativePayloads = replacementSettlementPending
          ? deferredReplacementPayloads(replacementFallback)
          : [];
        const nativeContent = replacementEmitFailed ? acknowledgedText || undefined : content;
        return {
          visibleReplySent: replacementEmitFailed ? Boolean(nativeContent) : true,
          ...(nativeContent === undefined ? {} : { content: nativeContent }),
          ...(logicalContent ? { logicalContent } : {}),
          ...(messageId && (!replacementEmitFailed || nativeContent) ? { messageId } : {}),
          ...(postNativePayloads.length > 0 ? { postNativePayloads } : {}),
        };
      } catch (err) {
        if (isStreamCancelledError(err)) {
          canceledLocally = true;
          return acknowledgedNativeDelivery();
        }
        // Non-cancel failure during the closing emit/close. Preserve only a
        // prefix acknowledged by Teams; queued bytes alone do not prove visibility.
        // Latch streamFailed for parity with the mid-stream path and
        // swallow the error — a thrown finalize would otherwise blow up
        // the reply pipeline after the user already saw the response.
        streamFailed = true;
        params.log?.warn?.(`msteams stream finalize failed: ${coerceErrorMessage(err)}`);
        return finalizeWithoutReceipt(logicalContent);
      } finally {
        // This segment's acknowledged-prefix fallback has been consumed.
        pendingFinalPayload = undefined;
        streamFinalizationPending = false;
        failedSegmentFallbackPrepared = true;
        queuedFinalActivity = undefined;
        replacementEmitFailed = false;
        replacementFinalPending = false;
        replacementSettlementPending = false;
        replacementTextAwaitingAcknowledgement = undefined;
        deferredReplacementEntries = [];
        releaseStreamChunkSubscription();
      }
    },

    hasStream(): boolean {
      return Boolean(stream);
    },

    isStreamActive(): boolean {
      return Boolean(stream) && tokensEmitted && !wasCanceled() && !streamFailed;
    },

    wasCanceled,
  };
}
