import {
  createChannelProgressDraftCompositor,
  resolveChannelPreviewStreamMode,
} from "openclaw/plugin-sdk/channel-outbound";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MarkdownTableMode, MSTeamsConfig, ReplyPayload } from "../runtime-api.js";
import { formatMSTeamsMarkdown } from "./format.js";
import { flattenInformativeStatus } from "./informative-status.js";
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

function hasUnstreamedContent(payload: ReplyPayload): boolean {
  return Boolean(payload.presentation || payload.mediaUrl || payload.mediaUrls?.length);
}

// How much of an unfinished line is safe to format and stream: it must not be able to
// become a block (list, heading, quote, table), and inline markup must be closed. Cut at
// the last word boundary where code, emphasis, strikethrough, and link syntax balance.
function streamablePartialLineLength(line: string): number {
  if (!/^[\p{L}"'({$]/u.test(line)) {
    return 0;
  }
  let safe = 0;
  let backticks = 0;
  let stars = 0;
  let tildes = 0;
  let brackets = 0;
  let parens = 0;
  for (let index = 0; index <= line.length; index += 1) {
    const char = line[index];
    const balanced = backticks % 2 === 0 && stars % 2 === 0 && tildes % 2 === 0;
    if (balanced && brackets === 0 && parens === 0 && (char === " " || char === undefined)) {
      safe = index;
    }
    if (
      char === undefined ||
      "|<>\\".includes(char) ||
      ((char === "@" || char === "!") && (line[index + 1] ?? "[") === "[") ||
      (char === "_" && !/[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(line.slice(index - 1, index + 2)))
    ) {
      if (char !== undefined) {
        break;
      }
      continue;
    }
    // A run such as "**" or "``" opens or closes one span.
    const runStart = char !== line[index - 1];
    backticks += char === "`" && runStart ? 1 : 0;
    stars += char === "*" && runStart ? 1 : 0;
    tildes += char === "~" && runStart ? 1 : 0;
    brackets += char === "[" ? 1 : char === "]" ? -1 : 0;
    parens += char === "(" && line[index - 1] === "]" ? 1 : char === ")" && parens > 0 ? -1 : 0;
  }
  return safe;
}

const FENCE_LINE_RE = /^[\s>*+\-\d.)]*(`{3,}|~{3,})(.*)$/u;

// Teams rejects a stream update that does not extend the text it already accepted, and
// formatting rewrites unfinished Markdown (heading and list markers, table layout, open
// fences). Format and stream only complete lines outside open fences and tables, plus
// the safe part of the unfinished line.
function streamableMarkdownLength(text: string): number {
  const lineStart = text.lastIndexOf("\n") + 1;
  const end = lineStart + streamablePartialLineLength(text.slice(lineStart));
  let safeEnd = 0;
  let openFence: string | undefined;
  let tableStart: number | undefined;
  for (let start = 0; start < end;) {
    const newline = text.indexOf("\n", start);
    const next = newline === -1 || newline >= end ? end : newline + 1;
    const line = text.slice(start, next);
    const fence = FENCE_LINE_RE.exec(line.replace(/\r?\n$/u, ""));
    if (openFence !== undefined) {
      // Only a bare run of the same character, at least as long, closes a fence.
      if (fence?.[1]?.startsWith(openFence) && !fence[2]?.trim()) {
        openFence = undefined;
      }
    } else if (fence?.[1]) {
      openFence = fence[1];
    } else {
      tableStart = line.includes("|") ? (tableStart ?? start) : undefined;
    }
    if (openFence === undefined && tableStart === undefined) {
      safeEnd = next;
    }
    start = next;
  }
  return safeEnd;
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
  let pendingFinalPayload: ReplyPayload | undefined;
  // The SDK appends deltas to cumulative pipeline text. Retain the text, not just
  // its length, because later snapshots can normalize trailing whitespace.
  let emittedText = "";
  // Partial mode streams formatted text; keep the source Markdown it was rendered from
  // and each rendered snapshot's source so acknowledgements map back to logical text.
  let emittedRawText = "";
  const renderedSourceLengths = new Map<number, number>();
  // The latest partial snapshot, including text still held back from the stream.
  let lastPartialText = "";
  // Text that went to block delivery before anything streamed; the stream must not then
  // start on a later segment.
  let streamSkipped = false;
  let acknowledgedText = "";
  let acknowledgedLogicalText = "";
  let acknowledgedStreamId: string | undefined;
  let replacementFinalPending = false;
  let replacementSettlementPending = false;
  let replacementTextAwaitingAcknowledgement: { text: string; logicalText: string } | undefined;
  let deferredReplacementEntries: { kind: "payload" | "replacement"; payload: ReplyPayload }[] = [];
  let queuedFinalActivity: ReturnType<typeof finalStreamActivity> | undefined;
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
        : emittedRawText.slice(0, renderedSourceLengths.get(activity.text.length) ?? 0) ||
          activity.text;
      if (replacementAcknowledgement) {
        replacementTextAwaitingAcknowledgement = undefined;
      }
    });
  }

  // SDK emit/update check this same flag synchronously; no cancellation can
  // arrive between this check and those calls without yielding.
  const wasCanceled = () => Boolean(stream?.canceled);

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
    if (!remainingText && !hasUnstreamedContent(payload)) {
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

  const queueFinalReplacement = (activeStream: NonNullable<typeof stream>, text: string) => {
    const activity = finalStreamActivity(text);
    replacementTextAwaitingAcknowledgement = { text: activity.text!, logicalText: text };
    activeStream.emit(activity);
    queuedFinalActivity = activity;
    emittedText = activity.text!;
    emittedRawText = text;
  };

  // The finalized message text, as one string, for any source Markdown.
  const renderStreamText = (text: string) => finalStreamActivity(text).text ?? "";

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
      const text = replacementFallback?.text;
      if (!text && !hasUnstreamedContent(entry.payload)) {
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
      stream.update(flattenInformativeStatus(text));
      return true;
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
      if (streamFinalizationPending || nativeDeliveryClaimed || streamSkipped) {
        return;
      }
      // Convert cumulative-text from the pipeline into deltas for the SDK's
      // appending sink. Without this, "Here's a" → "Here's a sonnet" → ...
      // gets emitted as full repeats and the SDK concatenates the lot.
      const fullText = payload.text;
      if (!lastPartialText.startsWith(fullText)) {
        // A different segment arrived while the first was still held back: the stream
        // can no longer own the first segment, so leave this turn to block delivery.
        if (!nativeDispatchStarted && !fullText.trimEnd().startsWith(lastPartialText.trimEnd())) {
          streamSkipped = true;
          return;
        }
        lastPartialText = fullText;
      }
      let prefixLength = 0;
      while (
        prefixLength < emittedRawText.length &&
        prefixLength < fullText.length &&
        emittedRawText[prefixLength] === fullText[prefixLength]
      ) {
        prefixLength += 1;
      }
      const previousRemainder = emittedRawText.slice(prefixLength);
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
        // The SDK can replace the same streamed activity after clearText().
        // Defer the authoritative final to preparePayload so this provider
        // round-trip also discovers a Stop before any fallback can escape.
        replacementFinalPending = true;
        replacementSettlementPending = true;
        pendingFinalPayload = { text: fullText };
        streamFinalizationPending = true;
        return;
      }
      // Stream the same formatting the final message uses. Hold text until it is safe to
      // format, and skip snapshots whose formatting would not extend what Teams accepted.
      // Each snapshot formats the whole streamable text, so long replies advance in steps
      // of about 1% instead of on every token.
      if (fullText.length - emittedRawText.length < emittedRawText.length / 100) {
        return;
      }
      const source = fullText.slice(0, streamableMarkdownLength(fullText));
      const rendered = source ? renderStreamText(source) : "";
      if (rendered.length <= emittedText.length || !rendered.startsWith(emittedText)) {
        return;
      }
      stream.emit(rendered.slice(emittedText.length));
      emittedText = rendered;
      emittedRawText = source;
      renderedSourceLengths.set(rendered.length, source.length);
      tokensEmitted = true;
      nativeDispatchStarted = true;
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
        queueFinalReplacement(stream, payload.text);
        tokensEmitted = false;
        // Replacement delivery owns all later payloads until close() proves
        // that Teams accepted the replacement or did not receive a Stop.
        return undefined;
      }
      // A native stream owns one final segment. Later progress payloads use
      // block delivery, just like later partial-mode segments after tools.
      if (streamMode === "progress" && payload.text && !nativeDispatchStarted) {
        stream.emit(payload.text);
        emittedText = payload.text;
        emittedRawText = payload.text;
        nativeDispatchStarted = true;
        tokensEmitted = true;
      }
      if (tokensEmitted) {
        const hasMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
        pendingFinalPayload = fallbackPayloadForSuppressedFinal(payload);
        streamFinalizationPending = true;
        tokensEmitted = false;
        if (!hasMedia) {
          return undefined;
        }
        // Cards must wait for close() to observe Stop; media keeps its existing delivery path.
        const {
          presentation: _presentation,
          presentationTextMode: _mode,
          ...mediaPayload
        } = payload;
        return { ...mediaPayload, text: undefined };
      }
      if (payload.text && !nativeDispatchStarted) {
        streamSkipped = true;
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
          logicalContent = deferredReplacementLogicalContent();
          queueFinalReplacement(stream, pendingFinalPayload.text);
        }
        logicalContent ??= replacementSettlementPending
          ? deferredReplacementLogicalContent()
          : undefined;
        // Without a final text payload, the latest partial is the reply, held text included.
        const streamedText = lastPartialText.startsWith(emittedRawText)
          ? lastPartialText
          : emittedRawText;
        const logicalText = pendingFinalPayload?.text ?? (streamedText || undefined);
        let finalActivity = queuedFinalActivity ?? finalStreamActivity(logicalText);
        // Formatting the whole reply normally extends the formatted text already streamed.
        // When it would rewrite streamed text instead, Teams would reject the final update,
        // so format only the unstreamed rest.
        if (
          !queuedFinalActivity &&
          streamMode === "partial" &&
          emittedText &&
          logicalText?.startsWith(emittedRawText) &&
          !finalActivity.text?.startsWith(emittedText)
        ) {
          const rest = logicalText.slice(emittedRawText.length);
          const gap = `${/\s*$/u.exec(emittedRawText)![0]}${/^\s*/u.exec(rest)![0]}`;
          const separator = gap.includes("\n\n") ? "\n\n" : gap.includes("\n") ? "\n" : gap && " ";
          // Text that only has meaning with the streamed part (a link definition) renders
          // to nothing alone; keep it as written.
          const renderedRest = rest.trim() ? renderStreamText(rest) || rest.trim() : "";
          finalActivity = {
            ...finalActivity,
            text: renderedRest ? `${emittedText}${separator}${renderedRest}` : emittedText,
          };
        }
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
        const messageId = extractMessageId(result) ?? acknowledgedStreamId;
        const postNativePayloads = replacementSettlementPending
          ? deferredReplacementPayloads(undefined)
          : pendingFinalPayload?.presentation
            ? [{ ...pendingFinalPayload, text: undefined }]
            : [];
        return {
          visibleReplySent: true,
          ...(content === undefined ? {} : { content }),
          ...(logicalContent ? { logicalContent } : {}),
          ...(messageId ? { messageId } : {}),
          ...(postNativePayloads.length > 0 ? { postNativePayloads } : {}),
        };
      } catch (err) {
        // Match SDK Stop failures by name: tsgo cannot resolve its error re-export
        // chain, and the SDK retry helper uses the same check.
        if (err instanceof Error && err.name === "StreamCancelledError") {
          return acknowledgedNativeDelivery();
        }
        // Non-cancel failure during the closing emit/close. Preserve only a
        // prefix acknowledged by Teams; queued bytes alone do not prove visibility.
        // Preserve the receipt and recover the unacknowledged suffix.
        params.log?.warn?.(`msteams stream finalize failed: ${coerceErrorMessage(err)}`);
        return finalizeWithoutReceipt(logicalContent);
      } finally {
        // This segment's acknowledged-prefix fallback has been consumed.
        pendingFinalPayload = undefined;
        streamFinalizationPending = false;
        queuedFinalActivity = undefined;
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
      return Boolean(stream) && tokensEmitted && !wasCanceled();
    },

    wasCanceled,
  };
}
