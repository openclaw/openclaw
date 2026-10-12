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
import { chunkFeishuMarkdown } from "./markdown.js";
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
import { planFeishuOutboundText } from "./outbound-text-plan.js";
import {
  assertFeishuCardWithinEnvelope,
  buildFeishuPresentationFallback,
  buildFeishuPayloadCard,
  consumeFeishuPresentationFallbackMarker,
  FEISHU_PRESENTATION_CAPABILITIES,
  markRenderedFeishuCard,
  projectPresentationForDelivery,
  readNativeFeishuCard,
  renderFeishuPresentationPayload,
  renderFeishuPresentationFallbackText,
  resolveFeishuRichReply,
} from "./presentation-card.js";
import type { FeishuReplyDeliverySource } from "./reply-delivery-result.js";
import { withFeishuSendContext } from "./send-context.js";
import {
  sendCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
  type CardHeaderConfig,
} from "./send.js";

// Preserve direct-send upload failures through the shared payload fallback contract.
export const FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER = "__openclawPropagateMediaUploadFailure";

type FeishuOutboundPayload = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0]["payload"];
type FeishuSendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];

// Direct sends surface upload failure; normal replies may deliver a text fallback.
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

function createFeishuReplyFanout(
  ctx: Pick<FeishuSendTextContext, "replyToId" | "threadId" | "replyToIdSource" | "replyToMode">,
) {
  return createReplyToFanout({
    replyToId: resolveFeishuReplyMode(ctx).normalizedReplyToId,
    replyToIdSource: ctx.replyToIdSource,
    replyToMode: ctx.replyToMode,
  });
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

  const { useCard, normalizedText, subChunks } = planFeishuOutboundText({
    cfg,
    accountId,
    text,
    header: params.header,
    formatting,
  });
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

  const nextReplyToId = createFeishuReplyFanout(ctx);
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

  const nextReplyToId = createFeishuReplyFanout(params.ctx);
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

async function deliverFeishuOutboundText(ctx: FeishuSendTextContext) {
  const { cfg, to, text, identity, onDeliveryResult, signal } = ctx;
  // Core asks the cancellation question before every text unit it cuts itself, but it hands
  // formatted text to this adapter whole and never cuts it, so the question is asked once on
  // the way in. The chunked send below asks it again before each message it fans out; the
  // branches that answer with a single upload or card never reach that loop.
  signal?.throwIfAborted();
  const { replyToMessageId, replyInThread } = resolveFeishuReplyMode(ctx);
  const sendParams = {
    cfg,
    to,
    accountId: ctx.accountId ?? undefined,
    replyToMessageId,
    replyInThread,
  };
  const deliveryOptions = feishuOutboundDeliveryOptions(ctx);
  // When upstream accidentally returns a local image path as plain text,
  // auto-upload and send as Feishu image message instead of leaking path text.
  const localImagePath = normalizePossibleLocalImagePath(text);
  if (localImagePath) {
    let mediaResult: Awaited<ReturnType<typeof sendMediaFeishu>>;
    try {
      mediaResult = await sendMediaFeishu({
        ...sendParams,
        mediaUrl: localImagePath,
        mediaAccess: ctx.mediaAccess,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
      });
    } catch (err) {
      if (isChannelPartialDeliveryError(err)) {
        // The image already reached Feishu; fallback text would duplicate a visible send.
        throw err;
      }
      console.error(`[feishu] local image path auto-send failed:`, err);
      return toFeishuOutboundResult(
        await sendOutboundText({
          ...sendParams,
          text: await buildFeishuMediaFallbackText({}),
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
        ...sendParams,
        text,
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
          ...sendParams,
          card: markRenderedFeishuCard(card),
        }),
        onDeliveryResult,
      ),
    );
  }

  const title = identity ? resolveFeishuIdentityHeaderTitle(identity) : undefined;
  return toFeishuOutboundResult(
    await sendOutboundText({
      ...sendParams,
      text,
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

    // The card and media share implicit first-reply consumption; native threads stay sticky.
    const nextReplyToId = createFeishuReplyFanout(ctx);
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
    sendMedia: async (ctx: Parameters<FeishuOutboundSendMedia>[0]) => {
      const {
        cfg,
        to,
        text,
        mediaUrl,
        audioAsVoice,
        onDeliveryResult,
        threadId,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        propagateMediaUploadFailure,
        signal,
      } = ctx;
      const sendParams = { cfg, to, accountId: ctx.accountId ?? undefined };
      const nextReplyToId = createFeishuReplyFanout(ctx);
      const nextReplyMode = () => {
        const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
          replyToId: nextReplyToId(),
          threadId,
        });
        return { replyToMessageId, replyInThread };
      };
      const deliveryOptions = feishuOutboundDeliveryOptions(ctx);
      const sendText = (value: string, replyMode = nextReplyMode()) =>
        sendOutboundText({ ...sendParams, text: value, ...replyMode, ...deliveryOptions });
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
        return toFeishuOutboundResult(await sendText(commentText));
      }

      if (!mediaUrl) {
        return toFeishuOutboundResult(await sendText(text ?? ""));
      }

      const suppressTextForVoiceMedia = shouldSuppressFeishuTextForVoiceMedia({
        mediaUrl,
        audioAsVoice,
      });
      let captionResult: Awaited<ReturnType<typeof sendOutboundText>> | undefined;

      // Send text first if provided, except for Feishu native voice bubbles.
      if (text?.trim() && !suppressTextForVoiceMedia) {
        captionResult = await sendText(text);
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
          ...sendParams,
          mediaUrl,
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
          // Preserve an accepted caption so recovery cannot send it again.
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
          // A rejected upload never delivered its attempted reply target.
          const fallbackResult = await sendText(
            fallbackText,
            captionResult ? nextReplyMode() : mediaReplyMode,
          );
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
          results.push(await sendText(text));
        }
      } catch (error) {
        throw partialFeishuSendError(error, results);
      }
      return toFeishuOutboundResult(aggregateFeishuSendResult(mediaResult, results));
    },
  }),
});
