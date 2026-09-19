import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { toStringifiedError as toFeishuError } from "openclaw/plugin-sdk/error-runtime";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  resolveSendableOutboundReplyParts,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
// Feishu plugin module owns the senders a reply uses: chunked text, posts, media and the
// no-visible-reply fallback.
import type { ClawdbotConfig, ReplyPayload } from "../runtime-api.js";
import {
  chunkFeishuPostMarkdown,
  materializeFeishuPostMarkdownSoftBreaks,
  postFencesSurvive,
} from "./markdown.js";
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  mergeFeishuReplyDeliveryResults,
  type FeishuReplyDeliveryResult,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import { getFeishuRuntime } from "./runtime.js";
import { chunkFeishuCardMarkdown, sendMessageFeishu, type CardHeaderConfig } from "./send.js";

type StreamingCloseOutcome = {
  disposition: "closed" | "discarded";
  result: FeishuReplyDeliveryResult;
  generation?: number;
  error?: unknown;
};

export type ClosedStreamingSettlement = StreamingCloseOutcome & {
  content: string;
  contentClaimed?: boolean;
};

type FeishuReplySenderContext = {
  core: ReturnType<typeof getFeishuRuntime>;
  cfg: ClawdbotConfig;
  account: { accountId: string };
  accountId?: string;
  sendTarget: string;
  sendReplyToMessageId?: string;
  effectiveReplyInThread?: boolean;
  allowTopLevelReplyFallback?: boolean;
  textChunkLimit: number;
  chunkMode: ChunkMode;
  postTableMode: MarkdownTableMode;
  requiredMentionTargets?: MentionTarget[];
  markVisibleReplySent: () => void;
  deliveredFinalTexts: Set<string>;
  blockPostDeliveries: Map<string, Promise<FeishuReplyDeliveryResult>>;
  closedStreamingSettlements: Map<number, ClosedStreamingSettlement>;
  tableNeedsPostPath: (value: string) => boolean;
  answerTableNeedsPostPath: (value: string) => boolean;
  readIdleSideEffects: () => Promise<void>;
  readVisibleReplySent: () => boolean;
  readReplyOutcome: () => { kind: string; reason?: string } | undefined;
  log?: (message: string) => void;
  error?: (message: string) => void;
  noVisibleReplyFallbackText: string;
};

/**
 * Every delivery a reply can make, given the account, the target and the table routing the
 * dispatcher resolved. Keeping them here leaves the dispatcher to own the streaming state and
 * the ordering, and gives these senders one place to agree on chunking and receipts.
 */
/**
 * The text before this branch converted it, when there is one. A payload whose visible prose
 * comes from a presentation carries no authored text of its own, and falling back to nothing
 * would deliver nothing at all, so the converted form stands.
 */
function authoredPostText(params: { text: string; authoredText?: string }): string {
  return params.authoredText?.trim() ? params.authoredText : params.text;
}

export function createFeishuReplySenders(ctx: FeishuReplySenderContext) {
  const {
    core,
    cfg,
    account,
    accountId,
    sendTarget,
    sendReplyToMessageId,
    effectiveReplyInThread,
    allowTopLevelReplyFallback,
    textChunkLimit,
    chunkMode,
    postTableMode,
    requiredMentionTargets,
    markVisibleReplySent,
    deliveredFinalTexts,
    blockPostDeliveries,
    closedStreamingSettlements,
    tableNeedsPostPath,
    answerTableNeedsPostPath,
  } = ctx;

  const sendChunkedTextReply = async (paramsLocal: {
    text: string;
    /** The text before this branch converted it, for a conversion the cut cannot carry. */
    authoredText?: string;
    useCard: boolean;
    infoKind?: string;
    firstChunkMentions?: MentionTarget[];
    chunkMentions?: MentionTarget[];
    header?: CardHeaderConfig;
    note?: string;
    sendChunk: (params: {
      chunk: string;
      isFirst: boolean;
      mentions?: MentionTarget[];
    }) => Promise<FeishuReplyDeliverySource>;
  }): Promise<FeishuReplyDeliveryResult> => {
    const convertedPostText = materializeFeishuPostMarkdownSoftBreaks(
      core.channel.text.convertMarkdownTables(paramsLocal.text, postTableMode),
    );
    // The shared fence scanner reads no quote prefix, so a converted blockquoted table
    // cannot be closed and reopened at a cut and its two markers land in different
    // messages. The outbound post path asks the same question of the same chunker. The
    // text can arrive converted already, since the payload is rendered before delivery, so
    // the question is whether the cut carries the markers rather than whether this step is
    // the step that produced them.
    const chunkSource = paramsLocal.useCard
      ? paramsLocal.text
      : postFencesSurvive(convertedPostText, {
            text: convertedPostText,
            limit: textChunkLimit,
            mode: chunkMode,
            firstChunkMentions: paramsLocal.firstChunkMentions,
            chunkMentions: paramsLocal.chunkMentions,
          })
        ? convertedPostText
        : materializeFeishuPostMarkdownSoftBreaks(authoredPostText(paramsLocal));
    const initialChunks = core.channel.text.chunkMarkdownTextWithMode(
      chunkSource,
      textChunkLimit,
      chunkMode,
    );
    const chunkOptions = {
      text: chunkSource,
      limit: textChunkLimit,
      mode: chunkMode,
      firstChunkMentions: paramsLocal.firstChunkMentions,
      chunkMentions: paramsLocal.chunkMentions,
      initialChunks,
    };
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      paramsLocal.useCard
        ? chunkFeishuCardMarkdown({
            ...chunkOptions,
            header: paramsLocal.header,
            note: paramsLocal.note,
          })
        : chunkFeishuPostMarkdown(chunkOptions),
    );
    const results: FeishuReplyDeliverySource[] = [];
    const acceptedChunks: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const mentions = [
        ...(paramsLocal.chunkMentions ?? []),
        ...(index === 0 ? (paramsLocal.firstChunkMentions ?? []) : []),
      ];
      try {
        const result = await paramsLocal.sendChunk({
          chunk,
          isFirst: index === 0,
          mentions: mentions.length > 0 ? mentions : undefined,
        });
        results.push(result);
        acceptedChunks.push(chunk);
        markVisibleReplySent();
      } catch (error: unknown) {
        const acceptedChunk = isChannelPartialDeliveryError(error)
          ? error.deliveryResult
          : undefined;
        if (acceptedChunk) {
          acceptedChunks.push(acceptedChunk.content ?? chunk);
          markVisibleReplySent();
        }
        throw createFeishuPartialReplyDeliveryError(error, {
          ...acceptedChunk,
          ...createFeishuReplyDeliveryResult({
            results,
            visibleReplySent: results.length > 0 || acceptedChunk !== undefined,
            content: acceptedChunks.join(""),
            kind: paramsLocal.useCard ? "card" : "text",
          }),
        });
      }
    }
    if (paramsLocal.infoKind === "final") {
      deliveredFinalTexts.add(paramsLocal.text);
    }
    return createFeishuReplyDeliveryResult({
      results,
      visibleReplySent: results.length > 0,
      // What was cut and sent, which is the authored text whenever the conversion could not
      // survive the cut. Reporting the requested text would record prose nobody received.
      content: chunkSource,
      kind: paramsLocal.useCard ? "card" : "text",
    });
  };

  const sendPostReply = (
    text: string,
    infoKind?: string,
    firstChunkMentions?: MentionTarget[],
    options?: { blockAnswerText?: string; authoredText?: string },
  ) => {
    const blockAnswerText = options?.blockAnswerText ?? text;
    // Block receipts are keyed by the rendered answer, never the reasoning preview
    // added by close. Keep that key separate from an unmatched close's post body.
    const matchingBlock =
      infoKind === "final" &&
      (tableNeedsPostPath(blockAnswerText) || answerTableNeedsPostPath(blockAnswerText))
        ? blockPostDeliveries.get(blockAnswerText)
        : undefined;
    const send = () =>
      sendChunkedTextReply({
        text,
        ...(options?.authoredText === undefined ? {} : { authoredText: options.authoredText }),
        useCard: false,
        infoKind,
        firstChunkMentions,
        chunkMentions: requiredMentionTargets,
        sendChunk: ({ chunk, mentions }) =>
          sendMessageFeishu({
            cfg,
            to: sendTarget,
            text: chunk,
            replyToMessageId: sendReplyToMessageId,
            replyInThread: effectiveReplyInThread,
            allowTopLevelReplyFallback,
            accountId,
            // The chunker above already converted, or deliberately did not when the
            // generated markers would not survive the cut. Without this the sender
            // converts a second time and rebuilds the table the guard just declined.
            preparedPostText: true,
            ...(mentions ? { mentions } : {}),
          }),
      });
    if (matchingBlock) {
      return matchingBlock.catch((error: unknown) => {
        // A partial failure still owns accepted chunks. Retrying the whole text
        // would duplicate them, and the error does not identify a retryable suffix.
        if (isChannelPartialDeliveryError(error)) {
          throw error;
        }
        return send();
      });
    }
    const delivery = send();
    if (infoKind === "block") {
      // Idle may overlap the send. Its matching preview inherits this post's
      // acceptance and receipt instead of starting a second delivery.
      const previousDelivery = blockPostDeliveries.get(text);
      const retainedDelivery = delivery.catch((error: unknown) => {
        // A later failed attempt cannot erase an earlier accepted post.
        if (previousDelivery) {
          return previousDelivery;
        }
        throw error;
      });
      blockPostDeliveries.set(text, retainedDelivery);
      void retainedDelivery.catch((error: unknown) => {
        if (
          !isChannelPartialDeliveryError(error) &&
          blockPostDeliveries.get(text) === retainedDelivery
        ) {
          blockPostDeliveries.delete(text);
        }
      });
    }
    return delivery;
  };

  const sendMediaReplies = async (
    payload: ReplyPayload,
    options?: { fallbackText?: string },
  ): Promise<FeishuReplyDeliveryResult> => {
    const mediaUrls = resolveSendableOutboundReplyParts(payload).mediaUrls;
    let sentFallbackText = false;
    let degradedVoiceFallbackText: string | undefined;
    const results: FeishuReplyDeliveryResult[] = [];
    try {
      await sendMediaWithLeadingCaption({
        mediaUrls,
        caption: "",
        send: async ({ mediaUrl }) => {
          const result = await sendMediaFeishu({
            cfg,
            to: sendTarget,
            mediaUrl,
            replyToMessageId: sendReplyToMessageId,
            replyInThread: effectiveReplyInThread,
            allowTopLevelReplyFallback,
            accountId,
            ...(payload.audioAsVoice === true ? { audioAsVoice: true } : {}),
          });
          results.push(
            createFeishuReplyDeliveryResult({
              results: [result],
              visibleReplySent: true,
              kind: result?.voiceIntentDegradedToFile ? "media" : undefined,
            }),
          );
          markVisibleReplySent();
          if (result?.voiceIntentDegradedToFile && options?.fallbackText && !sentFallbackText) {
            degradedVoiceFallbackText = options.fallbackText;
          }
        },
        onError:
          options?.fallbackText === undefined
            ? undefined
            : async ({ error, mediaUrl }) => {
                if (isChannelPartialDeliveryError(error)) {
                  // The attachment is already visible; text recovery would duplicate delivery.
                  markVisibleReplySent();
                  throw toFeishuError(error);
                }
                const fallbackText = await buildFeishuMediaFallbackText({
                  text: sentFallbackText ? undefined : options.fallbackText,
                  mediaUrl,
                });
                sentFallbackText = true;
                results.push(await sendPostReply(fallbackText, "final"));
              },
      });
      if (degradedVoiceFallbackText && !sentFallbackText) {
        sentFallbackText = true;
        results.push(await sendPostReply(degradedVoiceFallbackText, "final"));
      }
    } catch (error: unknown) {
      const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
      if (partial) {
        markVisibleReplySent();
      }
      throw createFeishuPartialReplyDeliveryError(
        error,
        mergeFeishuReplyDeliveryResults([...results, ...(partial ? [partial] : [])]),
      );
    }
    return mergeFeishuReplyDeliveryResults(results);
  };

  const ensureNoVisibleReplyFallback = async (reason: string): Promise<boolean> => {
    await ctx.readIdleSideEffects();
    if (ctx.readVisibleReplySent()) {
      return false;
    }
    const replyOutcome = ctx.readReplyOutcome();
    if (
      replyOutcome?.kind === "suppressed" ||
      (replyOutcome?.kind === "skipped" && replyOutcome.reason === "silent")
    ) {
      ctx.log?.(
        `feishu[${account.accountId}]: no-visible-reply fallback skipped for ${replyOutcome.reason} (${reason})`,
      );
      return false;
    }
    await sendMessageFeishu({
      cfg,
      to: sendTarget,
      text: ctx.noVisibleReplyFallbackText,
      replyToMessageId: sendReplyToMessageId,
      replyInThread: effectiveReplyInThread,
      allowTopLevelReplyFallback,
      accountId,
      ...(requiredMentionTargets?.length ? { mentions: requiredMentionTargets } : {}),
    });
    markVisibleReplySent();
    ctx.error?.(`feishu[${account.accountId}]: sent no-visible-reply fallback (${reason})`);
    return true;
  };

  const claimClosedStreamingResult = (
    generation: number | undefined,
    content: string | undefined,
  ): ClosedStreamingSettlement | undefined => {
    if (generation !== undefined) {
      // Several logical payloads can share one CardKit session, and media can delay each
      // completion until after close. The per-turn generation settlement is immutable so every
      // owner can reuse the same provider identity without emitting a duplicate fallback.
      const settlement = closedStreamingSettlements.get(generation);
      if (settlement) {
        settlement.contentClaimed = true;
      }
      return settlement;
    }
    let latestKey: number | undefined;
    for (const [key, settlement] of closedStreamingSettlements) {
      if (
        settlement.contentClaimed !== true &&
        (content === undefined || settlement.content === content)
      ) {
        latestKey = key;
      }
    }
    if (latestKey === undefined) {
      return undefined;
    }
    const result = closedStreamingSettlements.get(latestKey);
    if (result) {
      result.contentClaimed = true;
    }
    return result;
  };

  return {
    sendChunkedTextReply,
    sendPostReply,
    sendMediaReplies,
    ensureNoVisibleReplyFallback,
    claimClosedStreamingResult,
  };
}
