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
  codeBlockLines,
  materializeFeishuPostMarkdownSoftBreaks,
  postFencesSurvive,
} from "./markdown.js";
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention-target.types.js";
import { cardCarriesWholeTable, withinCardTableLimit } from "./presentation-card.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  mergeFeishuReplyDeliveryResults,
  type FeishuReplyDeliveryResult,
  type FeishuReplyDeliveryResultWithFinalization,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  chunkFeishuCardMarkdown,
  sendMessageFeishu,
  sendStructuredCardFeishu,
  type CardHeaderConfig,
} from "./send.js";
import { combineFeishuStreamText, formatReasoningPrefix } from "./streaming-update.js";

/**
 * A block's post or card: its text, its delivery and where it came from. A fallback card reports
 * a failure after its first chunk through its own block, and a card the close recovered for the
 * opening prose was created after the posts that preceded that close, whose number is the last
 * element, and before any later one. The preview card that close failed to rewrite was created
 * before those posts, so its receipt is kept beside it.
 */
export type FeishuBlockPostDelivery = [
  string,
  Promise<FeishuReplyDeliveryResult>,
  ("fallback" | "close")?,
  FeishuReplyDeliveryResult?,
  number?,
];

/** What a card that kept an earlier update still shows of `prose`: the update, less the reasoning set above it. */
function shownPrefix(prose: string, shown = ""): string {
  const rule = "\n\n---\n\n";
  const answer = shown.slice(shown.includes(rule) ? shown.lastIndexOf(rule) + rule.length : 0);
  return answer && prose.startsWith(answer) ? answer : "";
}

/**
 * The leading part of `text` that `sent` covers when the sender cut it into chunks, or "" when
 * the sent form was converted. A cut drops the whitespace it falls on, and the post writes a soft
 * line break as two spaces and a newline, so whitespace is skipped on both sides.
 */
function coveredPrefix(text: string, sent = ""): string {
  let at = 0;
  for (const char of sent) {
    if (/\s/u.test(char)) {
      continue;
    }
    while (!text.startsWith(char, at) && /\s/u.test(text[at] ?? "")) {
      at += 1;
    }
    if (!text.startsWith(char, at)) {
      return "";
    }
    at += char.length;
  }
  return text.slice(0, at);
}

/**
 * Where `block` starts in `text`, or -1. A copy whose lines are code where the block's own are
 * not, such as a fenced example of the table, is not where the block was posted.
 */
function blockOffset(text: string, block: string): number {
  const code = text.includes(block) ? codeBlockLines(text) : new Set<number>();
  const own = codeBlockLines(block);
  const lines = block.split("\n");
  for (
    let at = text.indexOf(block);
    at >= 0 && at < text.length;
    at = text.indexOf(block, at + 1)
  ) {
    const first = text.slice(0, at).split("\n").length - 1;
    if (lines.every((_, line) => code.has(first + line) === own.has(line))) {
      return at;
    }
  }
  return -1;
}

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
  rememberStreamingSettlement: (content: string, result: FeishuReplyDeliveryResult) => void;
  /** Hands a block post's receipt to the close, or nothing when an earlier block awaits it. */
  settleWithClose: (
    result: FeishuReplyDeliveryResult,
  ) => FeishuReplyDeliveryResultWithFinalization | undefined;
  tableNeedsPostPath: (value: string) => boolean;
  answerTableNeedsPostPath: (value: string) => boolean;
  resolveCardChrome: () => { header?: CardHeaderConfig; note?: string };
  isStreamingActive: () => boolean;
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
    rememberStreamingSettlement,
    tableNeedsPostPath,
    answerTableNeedsPostPath,
    resolveCardChrome,
  } = ctx;
  const replyTarget = {
    cfg,
    to: sendTarget,
    replyToMessageId: sendReplyToMessageId,
    replyInThread: effectiveReplyInThread,
    allowTopLevelReplyFallback,
    accountId,
  };

  // One option set for every card cut. The whole-table checks here and in the dispatcher
  // ask it before promoting text to a card, and the send measures the same chrome and
  // mentions, so a table that fits a bare card cannot be split once the card is dressed.
  const cardChunkOptions = (text: string, firstChunkMentions?: MentionTarget[]) => {
    const chrome = resolveCardChrome();
    return {
      text,
      limit: textChunkLimit,
      mode: chunkMode,
      header: chrome.header,
      note: chrome.note,
      firstChunkMentions,
      chunkMentions: requiredMentionTargets,
    };
  };
  const cardKeepsWholeTable = (text: string) =>
    cardCarriesWholeTable(text, (candidate) =>
      chunkFeishuCardMarkdown(cardChunkOptions(candidate)),
    );

  const sendChunkedTextReply = async (paramsLocal: {
    text: string;
    /** The text before this branch converted it, for a conversion the cut cannot carry. */
    authoredText?: string;
    useCard: boolean;
    infoKind?: string;
    firstChunkMentions?: MentionTarget[];
  }): Promise<FeishuReplyDeliveryResult> => {
    const chrome = paramsLocal.useCard ? resolveCardChrome() : undefined;
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
            chunkMentions: requiredMentionTargets,
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
      chunkMentions: requiredMentionTargets,
      initialChunks,
    };
    const chunks = resolveTextChunksWithFallback(
      chunkSource,
      paramsLocal.useCard
        ? chunkFeishuCardMarkdown({
            ...cardChunkOptions(chunkSource, paramsLocal.firstChunkMentions),
            initialChunks,
          })
        : chunkFeishuPostMarkdown(chunkOptions),
    );
    const results: FeishuReplyDeliverySource[] = [];
    const acceptedChunks: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const mentions = [
        ...(requiredMentionTargets ?? []),
        ...(index === 0 ? (paramsLocal.firstChunkMentions ?? []) : []),
      ];
      try {
        const sendParams = {
          ...replyTarget,
          text: chunk,
          ...(mentions.length > 0 ? { mentions } : {}),
        };
        const result = paramsLocal.useCard
          ? await sendStructuredCardFeishu({
              ...sendParams,
              header: chrome?.header,
              note: chrome?.note,
            })
          : await sendMessageFeishu({
              ...sendParams,
              // The chunker above already converted, or deliberately did not when the
              // generated markers would not survive the cut. Without this the sender
              // converts a second time and rebuilds the table the guard just declined.
              preparedPostText: true,
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

  // Every post and card of the message in progress, matched against the answer in text order.
  // A new message starts a new list, so a close still walking the old one is not disturbed.
  let blockPostDeliveries: FeishuBlockPostDelivery[] = [];
  // The answer the last close settled through its posts, and the mentions they carried.
  let closedAnswer: { text: string; mentions?: MentionTarget[] } | undefined;
  const sendPostReply = (
    text: string,
    infoKind?: string,
    firstChunkMentions?: MentionTarget[],
    options?: {
      /** The close's answer without its reasoning. Only the close passes it. */
      closeAnswerText?: string;
      /** The idle that posts what an earlier close left previewed, even when it owns no post yet. */
      later?: boolean;
      authoredText?: string;
      supplementalReasoningText?: string;
    },
  ) => {
    const blockAnswerText = options?.closeAnswerText ?? text;
    // Receipts use rendered block text, separate from the reasoning added by close.
    const matchingBlocks =
      infoKind === "final" &&
      (tableNeedsPostPath(blockAnswerText) || answerTableNeedsPostPath(blockAnswerText))
        ? blockPostDeliveries
        : undefined;
    const send = () =>
      sendChunkedTextReply({
        text,
        ...(options?.authoredText === undefined ? {} : { authoredText: options.authoredText }),
        useCard: false,
        infoKind,
        firstChunkMentions,
      });
    if (matchingBlocks && (matchingBlocks.length > 0 || options?.later)) {
      return (async () => {
        const accepted: FeishuReplyDeliveryResult[] = [];
        // The walk matches the card the close recovered for the opening prose first, since its
        // text comes first, but that card was created after the posts that preceded the close and
        // before any later one. Its receipt waits for those posts, while the preview card it
        // stands in for keeps its place ahead of them.
        let recovered: FeishuReplyDeliveryResult | undefined;
        let recoveredAfter = 0;
        let remaining = blockAnswerText;
        let answerComplete = false;
        let fallbackFailure: unknown;
        try {
          // Keep identical block occurrences in dispatch order. Only complete acceptance
          // advances the prefix; a partial rejection still owns its chunks. A fallback card
          // that failed after its first chunk owns them too, but its own block reported
          // that, so the rest goes out and the final then reports the same failure.
          for (const [
            at,
            [blockText, pending, origin, kept, created = 0],
          ] of matchingBlocks.entries()) {
            if (recovered && at > recoveredAfter) {
              accepted.push(recovered);
              recovered = undefined;
            }
            if (!remaining.startsWith(blockText)) {
              continue;
            }
            let block: FeishuReplyDeliveryResult;
            try {
              block = await pending;
            } catch (error: unknown) {
              if (!isChannelPartialDeliveryError(error)) {
                continue;
              }
              if (origin !== "fallback") {
                throw error;
              }
              block = error.deliveryResult;
              fallbackFailure = error.cause ?? error;
            }
            if (kept) {
              accepted.push(kept);
            }
            if (origin === "close" && created > 0) {
              recovered = block;
              recoveredAfter = created;
            } else {
              accepted.push(block);
            }
            remaining = remaining.slice(blockText.length).replace(/^\s*\n/u, "");
          }
          if (recovered) {
            accepted.push(recovered);
            recovered = undefined;
          }
          if (accepted.length === 0 && !options?.later) {
            return await send();
          }
          if (remaining.trim()) {
            // What this sends is owned from here on: a later walk finds it and sends only what
            // follows, and a partly accepted one keeps the chunks that went out.
            const tail = sendChunkedTextReply({
              text: remaining.trimStart(),
              useCard: false,
              firstChunkMentions,
            });
            const entry: FeishuBlockPostDelivery = [remaining, tail];
            matchingBlocks.push(entry);
            try {
              accepted.push(await tail);
            } catch (error: unknown) {
              const sent = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
              const covered = coveredPrefix(remaining, sent?.content);
              if (sent && covered) {
                entry[0] = covered;
                entry[1] = Promise.resolve(sent);
              } else {
                // An entry that owns no prefix would rethrow this rejection on every later walk.
                // Without it the next walk sends the remainder again, with any converted chunk.
                matchingBlocks.splice(matchingBlocks.indexOf(entry), 1);
              }
              throw error;
            }
          }
          answerComplete = true;
          const supplementalReasoningText = options?.supplementalReasoningText;
          if (supplementalReasoningText?.trim()) {
            // The accepted blocks or the remainder already carried the final's mentions.
            accepted.push(
              await sendChunkedTextReply({
                text: supplementalReasoningText,
                useCard: false,
              }),
            );
          }
          deliveredFinalTexts.add(blockAnswerText);
          if (options?.closeAnswerText !== undefined && matchingBlocks === blockPostDeliveries) {
            closedAnswer = { text: blockAnswerText, mentions: firstChunkMentions };
          }
        } catch (error: unknown) {
          const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
          // Only the close throws a remainder it rejected whole bare. Every receipt above
          // stays reusable and the close then owns nothing, so the matching final walks the
          // same receipts and sends only what is still missing. A partly sent card the walk
          // passed already failed through its own block. A final owns nothing when it fails,
          // so its error names the receipts and lets an attachment go out. So does a send
          // that accepted a chunk of its own, which the close then owns, and a failed
          // reasoning supplement, which cannot reach the final at all.
          if (!partial && !answerComplete && options?.closeAnswerText !== undefined) {
            throw error;
          }
          throw createFeishuPartialReplyDeliveryError(
            partial && error instanceof Error ? (error.cause ?? error) : error,
            mergeFeishuReplyDeliveryResults([
              ...accepted,
              ...(recovered ? [recovered] : []),
              ...(partial ? [partial] : []),
            ]),
          );
        }
        const settled = mergeFeishuReplyDeliveryResults(accepted);
        if (fallbackFailure !== undefined) {
          throw createFeishuPartialReplyDeliveryError(fallbackFailure, settled);
        }
        return settled;
      })();
    }
    const delivery = send();
    if (infoKind === "block") {
      // Retain each occurrence, including identical blocks, for an overlapping close.
      blockPostDeliveries.push([text, delivery]);
      void delivery.catch(() => undefined);
    }
    return delivery;
  };

  let leadingPreview = false;
  // Set beside it: the first post left previewed prose on the card on the block route, so that
  // post reports the close that settles the prose and the tail.
  let previewAdoptsClose = false;
  const leadingBlockProse = (answer: string, reasoning = "") => {
    const first = blockPostDeliveries[0];
    const at = leadingPreview && first ? blockOffset(answer, first[0]) : -1;
    if (at <= 0) {
      return undefined;
    }
    const text = answer.slice(0, at).trimEnd();
    if (!text) {
      return undefined;
    }
    const combined = combineFeishuStreamText(reasoning, text, "");
    const keepsReasoning =
      !tableNeedsPostPath(combined) &&
      chunkFeishuCardMarkdown(cardChunkOptions(combined)).length === 1;
    return {
      text,
      cardText: keepsReasoning ? combined : text,
      supplementalReasoningText: keepsReasoning ? undefined : formatReasoningPrefix(reasoning),
      // The card is the prose's receipt whenever it shows accepted content, and a close
      // that failed around that content is reported after the rest of the answer went
      // out. A card whose rewrite was rejected still shows what it last accepted, so a card
      // of its own carries only the prose that follows. The walk matches that card first,
      // and the receipts report it where it was created.
      settle: async (result: FeishuReplyDeliveryResult, error?: unknown) => {
        if (result.visibleReplySent && result.finalTextAccepted !== false) {
          blockPostDeliveries.unshift([text, Promise.resolve(result)]);
          return { result, closeError: error };
        }
        const created = blockPostDeliveries.length;
        const shown = result.visibleReplySent ? shownPrefix(text, result.content) : "";
        const recovered = sendChunkedTextReply({
          text: text.slice(shown.length).trim() || text,
          useCard: true,
          infoKind: "block",
        });
        blockPostDeliveries.unshift([text, recovered, "close", result, created]);
        void recovered.catch(() => undefined);
        return {
          result: mergeFeishuReplyDeliveryResults([result, await recovered]),
          closeError: error ?? new Error("Opening preview prose was not accepted"),
        };
      },
    };
  };

  const prepareBlockPost = async (preview: string, text: string) => {
    // The opening prose can stay above the posts only if the card already exists.
    const active = ctx.isStreamingActive();
    let remaining = preview;
    const leading = leadingBlockProse(preview);
    if (leading) {
      remaining = remaining.slice(leading.text.length).replace(/^\s*\n/u, "");
    }
    for (const [blockText, pending, origin] of blockPostDeliveries) {
      if (!remaining.startsWith(blockText)) {
        continue;
      }
      try {
        await pending;
      } catch (error: unknown) {
        if (!isChannelPartialDeliveryError(error)) {
          continue;
        }
        // A fallback card that failed after its first chunk reported that through its own
        // block, so the walk passes its text rather than resend it or refuse this block.
        if (origin !== "fallback") {
          throw error;
        }
      }
      remaining = remaining.slice(blockText.length).replace(/^\s*\n/u, "");
    }
    const at = blockOffset(remaining, text);
    const before = (at < 0 ? remaining : remaining.slice(0, at)).trimEnd();
    if (tableNeedsPostPath(before) || answerTableNeedsPostPath(before)) {
      return { text, answer: preview };
    }
    if (blockPostDeliveries.length === 0) {
      leadingPreview = Boolean(
        active &&
        before.trim() &&
        !tableNeedsPostPath(before) &&
        chunkFeishuCardMarkdown(cardChunkOptions(before)).length === 1,
      );
      previewAdoptsClose = leadingPreview && answerTableNeedsPostPath(text);
    }
    // Prose between posts has no earlier editable message. Put it ahead of the next
    // table now, rather than trying to repair its position after that table is sent.
    const posted =
      leadingPreview && blockPostDeliveries.length === 0
        ? text
        : at >= 0
          ? remaining.slice(0, at + text.length)
          : [before, text].filter(Boolean).join("\n\n");
    return {
      text: posted,
      answer:
        at >= 0 || blockOffset(preview, text) >= 0
          ? preview
          : [preview, text].filter(Boolean).join("\n\n"),
    };
  };

  // With the opening prose and the tail only previewed, the first post is the only caller the
  // close can report to. Its text is already in the chat, so the completion carries its receipt
  // alone and never asks the close for a recovery of it.
  const settleBlockPost = (results: FeishuReplyDeliveryResult[], infoKind?: string) => {
    const settled = mergeFeishuReplyDeliveryResults(results);
    const deferred =
      infoKind === "block" &&
      previewAdoptsClose &&
      blockPostDeliveries.length === 1 &&
      settled.visibleReplySent
        ? ctx.settleWithClose(
            createFeishuReplyDeliveryResult({ results: [settled], visibleReplySent: true }),
          )
        : undefined;
    // A later walk reads this post's own entry, so the entry carries the image the block sent right
    // after the post, ahead of whatever the walk posts after it.
    const entry = infoKind === "block" ? blockPostDeliveries.at(-1) : undefined;
    if (entry) {
      entry[1] = Promise.resolve(settled);
    }
    return deferred ? { ...settled, finalization: deferred.finalization } : settled;
  };

  // The core asks for idle whenever its send queue drains with a finalization pending, so the
  // close a table post adopted can run before the model run ends. The block route then previews
  // the rest of that answer with no card left to carry it, and the next idle posts it the way the
  // close would have, unless a final already delivered it. A caller exists only if a later block
  // or final asks for the same answer, so its receipt is remembered for that one.
  const postLaterTail = (answer: string) =>
    closedAnswer &&
    answer.length > closedAnswer.text.length &&
    answer.startsWith(closedAnswer.text) &&
    answerTableNeedsPostPath(answer) &&
    ![...deliveredFinalTexts].some((delivered) => delivered.startsWith(answer))
      ? sendPostReply(answer, "final", closedAnswer.mentions, {
          closeAnswerText: answer,
          later: true,
        }).then((result) => {
          rememberStreamingSettlement(answer, result);
          return result;
        })
      : undefined;

  // The next assistant message begins with no post of the earlier one to match, whether its
  // preview is a prefix of that message or not, and with nothing of its own settled yet.
  const startNextMessage = () => {
    blockPostDeliveries = [];
    leadingPreview = false;
    previewAdoptsClose = false;
    closedAnswer = closedAnswer && { text: "", mentions: closedAnswer.mentions };
    return "";
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
            ...replyTarget,
            mediaUrl,
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
      ...replyTarget,
      text: ctx.noVisibleReplyFallbackText,
      ...(requiredMentionTargets?.length ? { mentions: requiredMentionTargets } : {}),
    });
    markVisibleReplySent();
    ctx.error?.(`feishu[${account.accountId}]: sent no-visible-reply fallback (${reason})`);
    return true;
  };

  const streamingRecoveries = new WeakMap<
    FeishuReplyDeliveryResult,
    Map<string, Promise<FeishuReplyDeliveryResult>>
  >();

  const ensureVisibleStreamingDelivery = async (
    result: FeishuReplyDeliveryResult | undefined,
    content: string | undefined,
    infoKind?: string,
  ): Promise<FeishuReplyDeliveryResult | undefined> => {
    // A visible card whose final write was rejected only shows a stale preview; the
    // completed answer still has to reach the chat through a static card/message.
    if (
      (result?.visibleReplySent === true && result.finalTextAccepted !== false) ||
      !content?.trim()
    ) {
      return result;
    }
    let recoveries = result && streamingRecoveries.get(result);
    const pending = recoveries?.get(content);
    if (pending) {
      return pending;
    }
    const useRecoveryCard =
      !tableNeedsPostPath(content) &&
      !answerTableNeedsPostPath(content) &&
      withinCardTableLimit(content) &&
      // The recovery card promotes text the same way, so it asks the same question.
      cardKeepsWholeTable(content);
    const recovery = sendChunkedTextReply({
      text: content,
      useCard: useRecoveryCard,
      infoKind,
    }).then((delivered) => {
      rememberStreamingSettlement(content, delivered);
      return delivered;
    });
    if (infoKind === "block") {
      // A recovered block reached the chat, so a later matching final reuses it. A recovery
      // card reports a failure after its first chunk through its block, as a fallback card
      // does, so later walks pass it too. A recovery post keeps the post's refusal.
      blockPostDeliveries.push(
        useRecoveryCard ? [content, recovery, "fallback"] : [content, recovery],
      );
      void recovery.catch(() => undefined);
    }
    if (result) {
      if (!recoveries) {
        recoveries = new Map();
        streamingRecoveries.set(result, recoveries);
      }
      recoveries.set(content, recovery);
    }
    return recovery;
  };

  return {
    cardKeepsWholeTable,
    prepareBlockPost,
    leadingBlockProse,
    sendChunkedTextReply,
    sendPostReply,
    settleBlockPost,
    postLaterTail,
    startNextMessage,
    trackBlockPost: (entry: FeishuBlockPostDelivery) => blockPostDeliveries.push(entry),
    sendMediaReplies,
    ensureNoVisibleReplyFallback,
    ensureVisibleStreamingDelivery,
  };
}
