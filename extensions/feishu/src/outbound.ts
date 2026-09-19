// Feishu plugin module implements outbound behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createReplyToFanout } from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolveMarkdownTableMode,
  type MarkdownTableMode,
} from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import {
  getReplyPayloadTtsSupplement,
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { isRecord, normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { ChannelOutboundAdapter } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { sendCommentThreadReply } from "./comment-send.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { resolveFeishuIdentityHeaderTitle } from "./identity-header.js";
import { normalizePossibleLocalImagePath } from "./local-image-path.js";
import {
  chunkFeishuMarkdown,
  chunkFeishuPostMarkdown,
  postFencesSurvive,
  materializeFeishuPostMarkdownSoftBreaks,
} from "./markdown.js";
import { buildFeishuMediaFallbackText } from "./media-fallback.js";
import {
  sendMediaFeishu,
  shouldSuppressFeishuTextForVoiceMedia,
  type SendMediaResult,
} from "./media.js";
import { readNativeFeishuCardJson } from "./native-card.js";
import {
  feishuOutboundDeliveryOptions,
  type FeishuOutboundDeliveryOptions,
} from "./outbound-delivery-options.js";
import {
  aggregateFeishuSendResult,
  FEISHU_TEXT_CHUNK_LIMIT,
  partialFeishuSendError,
  reportFeishuOutboundDelivery,
  toFeishuOutboundResult,
  type FeishuSendTextContext,
} from "./outbound-send-result.js";
import {
  assertFeishuCardWithinEnvelope,
  buildFeishuPresentationFallback,
  buildFeishuPayloadCard,
  consumeFeishuPresentationFallbackMarker,
  FEISHU_PRESENTATION_CAPABILITIES,
  hasCardMarkdownTable,
  hasUndrawableCardTable,
  markRenderedFeishuCard,
  projectPresentationForDelivery,
  readNativeFeishuCard,
  renderFeishuPresentationPayload,
  renderFeishuPresentationFallbackText,
  resolveFeishuRichReply,
  shouldUseCard,
  withinCardTableLimit,
  cardCarriesWholeTable,
} from "./presentation-card.js";
import type { FeishuReplyDeliverySource } from "./reply-delivery-result.js";
import { withFeishuSendContext } from "./send-context.js";
import {
  chunkFeishuCardMarkdown,
  sendCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
  type CardHeaderConfig,
} from "./send.js";

// Carries the direct-send upload-failure policy through the presentation
// fallback delivery path. The normal `sendMedia` branch sets
// `propagateMediaUploadFailure` directly; the presentation-fallback branch
// routes through `sendPayload` (whose shared signature cannot carry the flag),
// so the direct `send` action stamps this marker on `channelData.feishu` and
// `sendFeishuFallbackPayload` reads it before calling `sendMedia`. This keeps
// a direct-send attachment failure visible instead of degrading to a
// fallback-text `ok:true` receipt (issue #112244, ClawSweeper P1).
export const FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER = "__openclawPropagateMediaUploadFailure";

type FeishuOutboundPayload = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0]["payload"];
type FeishuSendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];

// The Feishu sendMedia implementation accepts an optional flag the shared
// ChannelOutboundAdapter contract does not: when true, a media-upload failure
// is re-thrown to the caller instead of being converted to a fallback text
// success. The direct `send` action sets this so an agent that requested an
// attachment receives a visible failure when it cannot be delivered, rather
// than an `ok:true` receipt for a text-only fallback (issue #112244).
//
// The return type mirrors the shared contract exactly — `ReturnType<...>` is
// already `Promise<OutboundDeliveryResult>`, so wrapping it in another
// `Promise` would produce `Promise<Promise<...>>` and break the `async`
// implementation's single-Promise return (ClawSweeper P1).
export type FeishuOutboundSendMedia = (
  params: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0] & {
    propagateMediaUploadFailure?: boolean;
  },
) => ReturnType<NonNullable<ChannelOutboundAdapter["sendMedia"]>>;

// Reads (without consuming) the direct-send upload-failure policy stamped on
// the payload by the presentation-fallback branch. Unlike the presentation
// fallback marker this is not consumed: a fallback payload may fan out
// multiple `sendMedia` calls and each must honor the policy.
function readFeishuPropagateMediaUploadFailure(payload: FeishuOutboundPayload): boolean {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  return feishuData?.[FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER] === true;
}

type FeishuReplyMode =
  | { normalizedReplyToId: string; replyToMessageId: string; replyInThread: false }
  | { normalizedReplyToId: undefined; replyToMessageId: string; replyInThread: true }
  | { normalizedReplyToId: undefined; replyToMessageId: undefined; replyInThread: false };

// Target selection and thread mode are one decision; all payload parts reuse this result.
export function resolveFeishuReplyMode(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): FeishuReplyMode {
  const replyToMessageId = params.replyToId?.trim();
  if (replyToMessageId) {
    return { normalizedReplyToId: replyToMessageId, replyToMessageId, replyInThread: false };
  }

  const threadId = params.threadId == null ? undefined : String(params.threadId).trim();
  return threadId
    ? { normalizedReplyToId: undefined, replyToMessageId: threadId, replyInThread: true }
    : {
        normalizedReplyToId: undefined,
        replyToMessageId: undefined,
        replyInThread: false,
      };
}

async function sendOutboundText(
  params: FeishuOutboundDeliveryOptions & {
    cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
    to: string;
    text: string;
    replyToMessageId?: string;
    replyInThread?: boolean;
    accountId?: string;
    header?: CardHeaderConfig;
  },
) {
  const {
    cfg,
    to,
    text,
    accountId,
    replyToMessageId,
    replyInThread,
    onDeliveryResult,
    signal,
    formatting,
  } = params;
  const commentResult = await sendCommentThreadReply({
    ...feishuOutboundDeliveryOptions(params),
    cfg,
    to,
    text,
    replyId: replyToMessageId,
    accountId,
  });
  if (commentResult) {
    return commentResult;
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  // Resolve with block support so a configured or default block keeps native
  // tables on cards. An explicit off, bullets or code converts before routing,
  // so the mode applies in auto mode too, and a raw table promotes the message
  // to a card only when it renders natively. Card content is never touched by
  // the post-md newline normalization below.
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
    supportsBlockTables: true,
  });
  const nativeTables = tableMode === "block";
  const tableText = nativeTables ? text : convertMarkdownTables(text, tableMode);
  // off has no card representation, since a card renderer parses the pipes, so a
  // table that stays raw takes the post path even when cards were requested. The
  // card renderer's own parser answers what counts as a table here.
  // `shouldUseCard` answers true for a fenced block before it looks at tables, so an
  // auto send carrying both a fence and a shape the card renderer cannot draw would
  // reach a card and lose those rows. Ask about drawability here too. An explicit
  // `card` render mode still wins, which is the direct-send behaviour this change keeps.
  // Core plans its own text units against the delivery's formatting first and the resolved
  // account only after it, and a delivery that asks for a 1,000-character cut means the
  // messages the reader gets, not the units core would have cut. Registering
  // `sendFormattedText` moved the cut here, so this side reads the same order: the
  // per-delivery value wins, and the account setting stands when there is none.
  const postLimit =
    formatting?.textLimit ??
    resolveTextChunkLimit(cfg, "feishu", account.accountId, {
      fallbackLimit: FEISHU_TEXT_CHUNK_LIMIT,
    });
  const postChunkMode = formatting?.chunkMode ?? resolveChunkMode(cfg, "feishu", account.accountId);
  // A card carries a table as one component and the card chunker cuts on lines without
  // repeating the header and its delimiter, so every card after the first shows those
  // rows as raw pipes. A table that does not fit one card takes the post path instead,
  // which renders it as a fenced block that survives the cut. This branch taught the
  // promotion to recognise pipe-less tables, which used to miss it and land here anyway,
  // and the same cut applies to the piped ones the promotion already accepted.
  const cardKeepsTableWhole = cardCarriesWholeTable(tableText, (candidate) =>
    chunkFeishuCardMarkdown({
      text: candidate,
      limit: postLimit,
      mode: postChunkMode,
      header: params.header,
    }),
  );
  const useCard =
    (renderMode === "card" ||
      (renderMode === "auto" &&
        shouldUseCard(tableText, nativeTables) &&
        !hasUndrawableCardTable(tableText))) &&
    !(tableMode === "off" && hasCardMarkdownTable(tableText)) &&
    withinCardTableLimit(tableText) &&
    cardKeepsTableWhole;

  // Post rendering has no native tables, so block falls back to code there.
  // Tables need contiguous source rows, so convert them before the parser
  // materializes prose soft breaks for Feishu post rendering.
  const postTableText = nativeTables ? convertMarkdownTables(text, "code") : tableText;
  const postCandidate = materializeFeishuPostMarkdownSoftBreaks(postTableText);
  // The shared fence scanner does not read a quote-prefixed marker, so a converted
  // blockquoted table cannot be closed and reopened at a cut and its two markers land in
  // different messages. Ask the question of the text the send will actually chunk, soft
  // breaks materialized, the way the comment paths ask it of their own chunker.
  const postText =
    postTableText === text ||
    postFencesSurvive(postCandidate, {
      text: postCandidate,
      limit: postLimit,
      mode: postChunkMode,
    })
      ? postCandidate
      : materializeFeishuPostMarkdownSoftBreaks(text);
  const normalizedText = useCard ? tableText : postText;

  // Core chunks raw text before channel rendering. Re-chunk after expansion
  // and keep each fenced-code chunk independently valid Markdown.
  const chunkOptions = {
    text: normalizedText,
    limit: postLimit,
    mode: postChunkMode,
  };
  const subChunks = useCard
    ? chunkFeishuCardMarkdown({ ...chunkOptions, header: params.header })
    : chunkFeishuPostMarkdown(chunkOptions);
  const results: Awaited<ReturnType<typeof sendMessageFeishu>>[] = [];
  const preserveThread = replyInThread === true;
  const nextReplyToMessageId = createReplyToFanout({
    replyToId: replyToMessageId,
    replyToIdSource: params.replyToIdSource,
    replyToMode: params.replyToMode ?? "first",
  });
  const acceptedPostChunks: string[] = [];
  for (const [i, chunk] of (subChunks.length ? subChunks : [normalizedText]).entries()) {
    // Core asks this before every text unit it sends for a channel that leaves the cut to
    // it, and a channel that chunks its own text has to ask the same question or a
    // cancellation only stops the next payload. Ahead of the catch below, so the abort
    // reaches the caller as an abort rather than as a send failure; each chunk already
    // accepted was reported as it was sent.
    signal?.throwIfAborted();
    // Explicit replies and native topic roots stay sticky; implicit first replies do not.
    try {
      const sendParams = {
        cfg,
        to,
        text: chunk,
        accountId,
        replyToMessageId: preserveThread ? replyToMessageId : nextReplyToMessageId(),
        replyInThread: preserveThread ? true : i === 0 ? replyInThread : undefined,
      };
      const result = useCard
        ? await sendStructuredCardFeishu({ ...sendParams, header: params.header })
        : await sendMessageFeishu({ ...sendParams, preparedPostText: true });
      // Record acceptance before a callback or later chunk can fail.
      results.push(result);
      acceptedPostChunks.push(chunk);
      await reportFeishuOutboundDelivery(result, onDeliveryResult);
    } catch (error) {
      // The accepted sends carry the only text that reached the peer, and projection can
      // turn a message that fit into several of them. Without this the turn records the
      // unsent suffix as delivered, the same way the comment loop used to.
      // Feishu accepting a send without returning a receipt raises here rather than
      // returning, and that text reached the peer as surely as the chunks above it, so it
      // belongs in this content. The reply loop answers the same question the same way.
      const acceptedChunk = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
      const delivered = acceptedChunk
        ? [...acceptedPostChunks, acceptedChunk.content ?? chunk]
        : acceptedPostChunks;
      throw partialFeishuSendError(error, results, delivered.join(""));
    }
  }
  return aggregateFeishuSendResult(results.at(-1)!, results);
}

async function sendFeishuFallbackPayload(params: {
  ctx: FeishuSendPayloadContext;
  payload: FeishuOutboundPayload;
  separateMediaAndText?: boolean;
}) {
  // The direct `send` action stamps this marker when it routes an attachment
  // through the presentation-fallback path; honor it so an upload failure is
  // re-thrown instead of degrading to a fallback-text `ok:true` receipt
  // (issue #112244, ClawSweeper P1). The shared `sendTextMediaPayload` helper
  // cannot carry the flag, so when propagation is requested and there is media
  // to deliver, force the explicit fan-out path that calls `sendMedia` with
  // the flag set.
  const propagateMediaUploadFailure = readFeishuPropagateMediaUploadFailure(params.payload);
  const ctx = { ...params.ctx, payload: params.payload };
  const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(params.payload));
  const text = params.payload.text ?? "";
  const textChunks = text ? chunkFeishuMarkdown(text, FEISHU_TEXT_CHUNK_LIMIT) : [];
  const shouldSeparate =
    mediaUrls.length > 0 &&
    (propagateMediaUploadFailure || params.separateMediaAndText === true || textChunks.length > 1);
  if (!shouldSeparate) {
    return await sendTextMediaPayload({
      channel: "feishu",
      ctx,
      // The shared helper cuts the authored text before this channel's send converts it, and
      // that cut lands on a table, so every fragment after the first arrives as raw rows.
      // The send chunks again for its own target after converting, so the text goes whole,
      // the way the fanout below already sends it.
      adapter: { ...feishuOutbound, chunker: (value: string) => [value] },
    });
  }

  const { normalizedReplyToId } = resolveFeishuReplyMode({
    replyToId: ctx.replyToId,
    threadId: ctx.threadId,
  });
  const nextReplyToId = createReplyToFanout({
    replyToId: normalizedReplyToId,
    replyToIdSource: ctx.replyToIdSource,
    replyToMode: ctx.replyToMode,
  });
  // Narrow the optional shared `sendMedia` to the Feishu-specific contract so
  // the `propagateMediaUploadFailure` flag can be carried on direct-send
  // fallback delivery (the shared `ChannelOutboundAdapter["sendMedia"]`
  // signature does not declare it).
  const sendMedia: FeishuOutboundSendMedia | undefined = feishuOutbound.sendMedia;
  const sendText = feishuOutbound.sendText;
  if (!sendMedia || !sendText) {
    throw new Error("Feishu fallback delivery is not available.");
  }

  // Card fallbacks can exceed media-caption limits. Deliver attachments first,
  // then preserve the complete fallback through the normal 4k text fanout.
  let lastResult: Awaited<ReturnType<typeof sendText>> | undefined;
  for (const mediaUrl of mediaUrls) {
    ctx.signal?.throwIfAborted();
    lastResult = await sendMedia({
      ...ctx,
      text: "",
      mediaUrl,
      replyToId: nextReplyToId(),
      audioAsVoice: params.payload.audioAsVoice ?? ctx.audioAsVoice,
      ...(propagateMediaUploadFailure ? { propagateMediaUploadFailure: true } : {}),
    });
  }
  if (text) {
    ctx.signal?.throwIfAborted();
    // The fanout used to send these fragments one at a time, but the cut here lands on
    // the authored text, before the target's own table conversion runs. A table longer
    // than the fragment keeps its header only in the first one and the rest arrive as raw
    // pipes. `sendText` chunks again for its target anyway, after converting, so the whole
    // text goes in one call and the fragments above only decide whether media is split
    // from text at all.
    lastResult = await sendText({
      ...ctx,
      text,
      replyToId: nextReplyToId(),
    });
  }
  return lastResult!;
}

async function sendFeishuTtsSupplementPayload(params: {
  ctx: FeishuSendPayloadContext;
  payload: FeishuOutboundPayload;
  supplement: NonNullable<ReturnType<typeof getReplyPayloadTtsSupplement>>;
  hasVisiblePresentationFallback?: boolean;
  sendVisiblePayload?: (
    replyToId: string | undefined,
  ) => ReturnType<NonNullable<ChannelOutboundAdapter["sendText"]>>;
}) {
  const sendMedia = feishuOutbound.sendMedia;
  const sendText = feishuOutbound.sendText;
  if (!sendMedia || !sendText) {
    throw new Error("Feishu TTS supplement delivery is not available.");
  }

  const { normalizedReplyToId } = resolveFeishuReplyMode({
    replyToId: params.ctx.replyToId,
    threadId: params.ctx.threadId,
  });
  const nextReplyToId = createReplyToFanout({
    replyToId: normalizedReplyToId,
    replyToIdSource: params.ctx.replyToIdSource,
    replyToMode: params.ctx.replyToMode,
  });
  const ctx = { ...params.ctx, payload: params.payload };
  let lastResult: Awaited<ReturnType<typeof sendText>> | undefined;

  // Structured payloads still need their actions. Plain text follows the TTS
  // visibility marker so an existing streamed reply is not duplicated.
  if (params.sendVisiblePayload) {
    lastResult = await params.sendVisiblePayload(nextReplyToId());
    await ctx.onDeliveryResult?.(lastResult);
  } else if (
    params.hasVisiblePresentationFallback ||
    params.supplement.visibleTextAlreadyDelivered !== true
  ) {
    const text = params.payload.text?.trim() ? params.payload.text : params.supplement.spokenText;
    if (text) {
      // Whole text, one call. Cutting it here lands on the authored table, before the
      // target converts it, so a table longer than a fragment would keep its header only
      // in the first one. `sendText` chunks again for its own target, after converting.
      lastResult = await sendText({
        ...ctx,
        text,
        replyToId: nextReplyToId(),
      });
    }
  }

  for (const mediaUrl of normalizeStringEntries(resolvePayloadMediaUrls(params.payload))) {
    ctx.signal?.throwIfAborted();
    lastResult = await sendMedia({
      ...ctx,
      text: "",
      mediaUrl,
      replyToId: nextReplyToId(),
      audioAsVoice: params.payload.audioAsVoice ?? ctx.audioAsVoice,
    });
  }
  return lastResult ?? { channel: "feishu", messageId: "" };
}

// The direct-send action builds its presentation card before reaching
// `sendPayload`, so it shares these resolvers instead of repeating the rule. The card
// asks for the mode as well as for the renderer, because a mode that converts nothing
// still says whether the card may replace a shape it cannot draw.
export function presentationTableMode(
  ctx: Pick<FeishuSendPayloadContext, "cfg" | "accountId">,
): MarkdownTableMode {
  const account = resolveFeishuAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  return resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "feishu",
    accountId: account.accountId,
    supportsBlockTables: true,
  });
}

export function presentationTextRenderer(ctx: Pick<FeishuSendPayloadContext, "cfg" | "accountId">) {
  const tableMode = presentationTableMode(ctx);
  return (text: string) => (tableMode === "block" ? text : convertMarkdownTables(text, tableMode));
}

function withFeishuOutboundSendContext(adapter: ChannelOutboundAdapter): ChannelOutboundAdapter {
  // Every text sender this adapter advertises needs the scope, not just the per-message one.
  // The authority checks deeper in the client read an ambient store, so a sender left out of
  // this set reaches the transport with no scope to find and every one of those checks
  // becomes a no-op for that route.
  const { sendText, sendFormattedText, sendMedia, sendPayload } = adapter;
  return {
    ...adapter,
    ...(sendText
      ? { sendText: async (ctx) => withFeishuSendContext(ctx, () => sendText(ctx)) }
      : {}),
    ...(sendFormattedText
      ? {
          sendFormattedText: async (ctx) =>
            withFeishuSendContext(ctx, () => sendFormattedText(ctx)),
        }
      : {}),
    ...(sendMedia
      ? { sendMedia: async (ctx) => withFeishuSendContext(ctx, () => sendMedia(ctx)) }
      : {}),
    ...(sendPayload
      ? { sendPayload: async (ctx) => withFeishuSendContext(ctx, () => sendPayload(ctx)) }
      : {}),
  };
}

// `feishuOutbound` keeps the shared `ChannelOutboundAdapter` shape (whose
// `sendMedia` is optional) so the object literal — which spreads
// `createAttachedChannelResultAdapter` (returning `sendMedia?: ... | undefined`)
// — type-checks without a `sendMedia: ... | undefined` mismatch. Callers that
// need the Feishu-specific `propagateMediaUploadFailure` flag narrow the
// optional `sendMedia` to `FeishuOutboundSendMedia` at the use site
// (channel.ts direct-send branch, sendFeishuFallbackPayload) instead of
// forcing a required property here (ClawSweeper P1).
async function deliverFeishuOutboundText(ctx: FeishuSendTextContext) {
  const { cfg, to, text, accountId, replyToId, threadId, identity, onDeliveryResult, signal } = ctx;
  const { mediaAccess, mediaLocalRoots, mediaReadFile } = ctx;
  // Core asks the cancellation question before every text unit it cuts itself, but it hands
  // formatted text to this adapter whole and never cuts it, so the question is asked once on
  // the way in. The chunked send below asks it again before each message it fans out; the
  // branches that answer with a single upload or card never reach that loop.
  signal?.throwIfAborted();
  const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
    replyToId,
    threadId,
  });
  const deliveryOptions = feishuOutboundDeliveryOptions(ctx);
  // Scheme A compatibility shim:
  // when upstream accidentally returns a local image path as plain text,
  // auto-upload and send as Feishu image message instead of leaking path text.
  const localImagePath = normalizePossibleLocalImagePath(text);
  if (localImagePath) {
    let mediaResult: Awaited<ReturnType<typeof sendMediaFeishu>>;
    try {
      mediaResult = await sendMediaFeishu({
        cfg,
        to,
        mediaUrl: localImagePath,
        accountId: accountId ?? undefined,
        replyToMessageId,
        replyInThread,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
      });
    } catch (err) {
      if (isChannelPartialDeliveryError(err)) {
        // The image already reached Feishu; fallback text would duplicate a visible send.
        throw err;
      }
      console.error(`[feishu] local image path auto-send failed:`, err);
      return toFeishuOutboundResult(
        await sendOutboundText({
          cfg,
          to,
          text: await buildFeishuMediaFallbackText({}),
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
          ...deliveryOptions,
        }),
      );
    }
    return toFeishuOutboundResult(
      await reportFeishuOutboundDelivery(mediaResult, onDeliveryResult),
    );
  }

  if (parseFeishuCommentTarget(to)) {
    return toFeishuOutboundResult(
      await sendOutboundText({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        replyToMessageId,
        replyInThread,
        ...deliveryOptions,
      }),
    );
  }

  const card = readNativeFeishuCardJson(text);
  if (card) {
    assertFeishuCardWithinEnvelope(card, "Feishu native card");
    return toFeishuOutboundResult(
      await reportFeishuOutboundDelivery(
        await sendCardFeishu({
          cfg,
          to,
          card: markRenderedFeishuCard(card),
          accountId: accountId ?? undefined,
          replyToMessageId,
          replyInThread,
        }),
        onDeliveryResult,
      ),
    );
  }

  const title = identity ? resolveFeishuIdentityHeaderTitle(identity) : undefined;
  return toFeishuOutboundResult(
    await sendOutboundText({
      cfg,
      to,
      text,
      accountId: accountId ?? undefined,
      replyToMessageId,
      replyInThread,
      header: title ? { title, template: "blue" } : undefined,
      ...deliveryOptions,
    }),
  );
}

export const feishuOutbound: ChannelOutboundAdapter = withFeishuOutboundSendContext({
  deliveryMode: "direct",
  chunker: chunkFeishuMarkdown,
  chunkerMode: "markdown",
  textChunkLimit: FEISHU_TEXT_CHUNK_LIMIT,
  presentationCapabilities: FEISHU_PRESENTATION_CAPABILITIES,
  // Core cuts a reply to its own budget before this channel converts it, and that cut lands on
  // a table, so the branch that would do it hands the whole text here instead and the send
  // chunks after converting. One result stands for the messages it made, the way the payload
  // path already reports them.
  sendFormattedText: async (ctx) => [
    attachChannelToResult("feishu", await deliverFeishuOutboundText(ctx)),
  ],
  renderPresentation: (params) => {
    const renderText = presentationTextRenderer(params.ctx);
    const presentation = projectPresentationForDelivery({ ...params, renderText });
    return renderFeishuPresentationPayload({
      ...params,
      payload: { ...params.payload, presentation },
      presentation,
      ctx: { ...params.ctx, renderText, tableMode: presentationTableMode(params.ctx) },
    });
  },
  sendPayload: async (ctx) => {
    const { payload, presentationFallback } = consumeFeishuPresentationFallbackMarker(ctx.payload);
    // Core-rendered payloads already carry their card or fallback. Only authored
    // presentations reaching this entry directly still need the prose projection.
    const renderText = resolveFeishuRichReply(payload).presentation
      ? presentationTextRenderer(ctx)
      : undefined;
    const ttsSupplement = getReplyPayloadTtsSupplement(payload);
    if (parseFeishuCommentTarget(ctx.to)) {
      const { presentation } = resolveFeishuRichReply(payload);
      // Document comments cannot render cards. Resolve the text path before
      // validating card limits so unused native card data cannot block delivery.
      const textCard = readNativeFeishuCardJson(payload.text);
      const fallbackSourceText = textCard ? undefined : payload.text;
      const { commentText: text, fallbackText } = buildFeishuPresentationFallback({
        text: fallbackSourceText,
        presentation,
        fallbackHasCommand:
          isRecord(payload.channelData?.feishu) &&
          payload.channelData.feishu.fallbackHasCommand === true,
      });
      const hasFallbackMedia = normalizeStringEntries(resolvePayloadMediaUrls(payload)).length > 0;
      if (
        !fallbackText.trim() &&
        !hasFallbackMedia &&
        (textCard || readNativeFeishuCard(payload))
      ) {
        throw new Error(
          "Feishu native cards cannot be sent to document comments without a text or media fallback.",
        );
      }
      const fallbackPayload = {
        ...payload,
        text,
        interactive: undefined,
        presentation: undefined,
        channelData: undefined,
      };
      return await sendFeishuFallbackPayload({
        ctx,
        payload: fallbackPayload,
        separateMediaAndText: true,
      });
    }
    const card = buildFeishuPayloadCard({
      payload,
      text: ctx.text,
      identity: ctx.identity,
      renderText,
      ...(renderText ? { tableMode: presentationTableMode(ctx) } : {}),
    });
    if (!card) {
      const { presentation } = resolveFeishuRichReply(payload);
      // The senders below convert for their own target and stand that conversion down when
      // the cut cannot carry the markers it generated, so what they need is the authored
      // prose. Converting here first, or forwarding prose the renderer already converted,
      // hands them a conversion they cannot undo, and a quoted table's opening and closing
      // markers then reach separate messages. The renderer records the authored form beside
      // the converted one for exactly this reason.
      const fallbackPayload = presentation
        ? {
            ...payload,
            text: renderFeishuPresentationFallbackText(
              {
                text: readNativeFeishuCardJson(payload.text) ? undefined : payload.text,
                presentation,
              },
              "markdown",
            ),
            presentation: undefined,
            interactive: undefined,
          }
        : presentationFallback?.authoredText === undefined
          ? payload
          : { ...payload, text: presentationFallback.authoredText };
      if (ttsSupplement) {
        return await sendFeishuTtsSupplementPayload({
          ctx,
          payload: fallbackPayload,
          supplement: ttsSupplement,
          // Empty structural presentations must not replay already-streamed prose.
          hasVisiblePresentationFallback:
            presentationFallback?.hasVisibleContent ??
            Boolean(renderFeishuPresentationFallbackText({ presentation }).trim()),
        });
      }
      return await sendFeishuFallbackPayload({
        ctx,
        payload: fallbackPayload,
        separateMediaAndText: presentationFallback !== undefined || presentation !== undefined,
      });
    }

    if (ttsSupplement) {
      return await sendFeishuTtsSupplementPayload({
        ctx,
        payload,
        supplement: ttsSupplement,
        sendVisiblePayload: async (replyToId) => {
          const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
            replyToId,
            threadId: ctx.threadId,
          });
          return attachChannelToResult(
            "feishu",
            toFeishuOutboundResult(
              await sendCardFeishu({
                cfg: ctx.cfg,
                to: ctx.to,
                card,
                replyToMessageId,
                replyInThread,
                accountId: ctx.accountId ?? undefined,
              }),
            ),
          );
        },
      });
    }

    const { normalizedReplyToId } = resolveFeishuReplyMode({
      replyToId: ctx.replyToId,
      threadId: ctx.threadId,
    });
    // Media and the final card are separate payloads: consume an implicit
    // first-reply id once, while an explicit thread remains sticky for both.
    const nextReplyToId = createReplyToFanout({
      replyToId: normalizedReplyToId,
      replyToIdSource: ctx.replyToIdSource,
      replyToMode: ctx.replyToMode,
    });
    const nextReplyMode = () =>
      resolveFeishuReplyMode({
        replyToId: nextReplyToId(),
        threadId: ctx.threadId,
      });
    const mediaUrls = normalizeStringEntries(resolvePayloadMediaUrls(payload));
    return attachChannelToResult(
      "feishu",
      toFeishuOutboundResult(
        await sendPayloadMediaSequenceAndFinalize<
          SendMediaResult,
          Awaited<ReturnType<typeof sendCardFeishu>>
        >({
          text: payload.text ?? "",
          mediaUrls,
          onResult: async (deliveryResult) => {
            await ctx.onDeliveryResult?.(
              attachChannelToResult("feishu", toFeishuOutboundResult(deliveryResult)),
            );
          },
          send: async ({ mediaUrl }) => {
            const { replyToMessageId, replyInThread } = nextReplyMode();
            return await sendMediaFeishu({
              cfg: ctx.cfg,
              to: ctx.to,
              mediaUrl,
              accountId: ctx.accountId ?? undefined,
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
              replyToMessageId,
              replyInThread,
              ...(payload.audioAsVoice === true || ctx.audioAsVoice === true
                ? { audioAsVoice: true }
                : {}),
            });
          },
          finalize: async () => {
            const { replyToMessageId, replyInThread } = nextReplyMode();
            return await sendCardFeishu({
              cfg: ctx.cfg,
              to: ctx.to,
              card,
              replyToMessageId,
              replyInThread,
              accountId: ctx.accountId ?? undefined,
            });
          },
        }),
      ),
    );
  },
  ...createAttachedChannelResultAdapter({
    channel: "feishu",
    sendText: async (ctx) => await deliverFeishuOutboundText(ctx),
    sendMedia: async (
      ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0] & {
        /** When true, a media-upload failure is re-thrown to the caller instead of
         * being converted to a fallback text success. The direct `send` action
         * sets this so an agent that requested an attachment receives a visible
         * failure when the attachment cannot be delivered, rather than an `ok:true`
         * receipt for a text-only fallback (issue #112244). */
        propagateMediaUploadFailure?: boolean;
      },
    ) => {
      const { cfg, to, text, mediaUrl, audioAsVoice, accountId, replyToId, threadId } = ctx;
      const { mediaAccess, mediaLocalRoots, mediaReadFile, onDeliveryResult, signal } = ctx;
      const { replyToIdSource, replyToMode, propagateMediaUploadFailure = false } = ctx;
      const { normalizedReplyToId } = resolveFeishuReplyMode({
        replyToId,
        threadId,
      });
      const nextReplyToId = createReplyToFanout({
        replyToId: normalizedReplyToId,
        replyToIdSource,
        replyToMode,
      });
      const nextReplyMode = () => {
        const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
          replyToId: nextReplyToId(),
          threadId,
        });
        return { replyToMessageId, replyInThread };
      };
      const deliveryOptions = feishuOutboundDeliveryOptions(ctx);
      if (parseFeishuCommentTarget(to)) {
        // Document comments deliver media as visible links; they never enter
        // the upload path or use its failure-propagation policy.
        const commentText = mediaUrl?.trim()
          ? await buildFeishuMediaFallbackText({
              text,
              mediaUrl,
              mediaLinkStyle: "plain",
            })
          : (text?.trim() ?? "");
        return toFeishuOutboundResult(
          await sendOutboundText({
            cfg,
            to,
            text: commentText,
            accountId: accountId ?? undefined,
            ...nextReplyMode(),
            ...deliveryOptions,
          }),
        );
      }

      if (!mediaUrl) {
        return toFeishuOutboundResult(
          await sendOutboundText({
            cfg,
            to,
            text: text ?? "",
            accountId: accountId ?? undefined,
            ...nextReplyMode(),
            ...deliveryOptions,
          }),
        );
      }

      const suppressTextForVoiceMedia = shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl,
        audioAsVoice,
      });
      let captionResult: Awaited<ReturnType<typeof sendOutboundText>> | undefined;

      // Send text first if provided, except for Feishu native voice bubbles.
      if (text?.trim() && !suppressTextForVoiceMedia) {
        captionResult = await sendOutboundText({
          cfg,
          to,
          text,
          accountId: accountId ?? undefined,
          ...nextReplyMode(),
          ...deliveryOptions,
        });
      }

      const results: FeishuReplyDeliverySource[] = captionResult ? [captionResult] : [];
      let mediaResult: Awaited<ReturnType<typeof sendMediaFeishu>>;
      // The caption above is its own physical send, so the attachment asks the cancellation
      // question again, ahead of the upload's own catch: an abort is not an upload failure,
      // and the fallback text there would be one more message the turn no longer owns.
      signal?.throwIfAborted();
      const mediaReplyMode = nextReplyMode();
      try {
        mediaResult = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          ...mediaReplyMode,
          ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
        });
      } catch (err) {
        if (isChannelPartialDeliveryError(err)) {
          // Accepted media is not an upload failure and must never trigger a second send.
          throw partialFeishuSendError(err, results);
        }
        if (propagateMediaUploadFailure) {
          // The direct `send` action requested a controlled failure when the
          // attachment cannot be delivered, so the agent receives a visible
          // error instead of an `ok:true` receipt for a text-only fallback
          // (issue #112244). When the caption was already delivered, preserve
          // its receipt as the existing partial-delivery outcome so the caller
          // knows the text is visible and does not retry it (which would
          // duplicate the caption); only a send with no delivered caption is a
          // wholly failed send.
          if (captionResult) {
            throw partialFeishuSendError(err, results);
          }
          throw new Error(
            `Feishu send could not deliver the requested media attachment: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        const fallbackText = await buildFeishuMediaFallbackText({
          text: captionResult ? undefined : text,
          mediaUrl,
        });
        try {
          const fallbackResult = await sendOutboundText({
            cfg,
            to,
            text: fallbackText,
            accountId: accountId ?? undefined,
            // A rejected upload never delivered its attempted reply target.
            ...(captionResult ? nextReplyMode() : mediaReplyMode),
            ...deliveryOptions,
          });
          return toFeishuOutboundResult(
            aggregateFeishuSendResult(fallbackResult, [...results, fallbackResult]),
          );
        } catch (error) {
          throw partialFeishuSendError(error, results);
        }
      }

      // Persist the accepted attachment before any later fallible text action.
      results.push(mediaResult);
      try {
        await reportFeishuOutboundDelivery(mediaResult, onDeliveryResult);
        if (mediaResult.voiceIntentDegradedToFile && text?.trim()) {
          results.push(
            await sendOutboundText({
              cfg,
              to,
              text,
              accountId: accountId ?? undefined,
              ...nextReplyMode(),
              ...deliveryOptions,
            }),
          );
        }
      } catch (error) {
        throw partialFeishuSendError(error, results);
      }
      return toFeishuOutboundResult(aggregateFeishuSendResult(mediaResult, results));
    },
  }),
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
