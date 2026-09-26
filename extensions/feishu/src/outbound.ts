import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  createReplyToFanout,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import {
  getReplyPayloadTtsSupplement,
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { statRegularFileSync } from "openclaw/plugin-sdk/security-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { ChannelOutboundAdapter } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { sendCommentThreadReply } from "./comment-send.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { resolveFeishuIdentityHeaderTitle } from "./identity-header.js";
import {
  chunkFeishuMarkdown,
  shouldUseFeishuCard,
  chunkFeishuPostMarkdown,
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
  assertFeishuCardWithinEnvelope,
  buildFeishuPresentationFallback,
  buildFeishuPayloadCard,
  consumeFeishuPresentationFallbackMarker,
  FEISHU_PRESENTATION_CAPABILITIES,
  markRenderedFeishuCard,
  readNativeFeishuCard,
  renderFeishuPresentationPayload,
  renderFeishuPresentationFallbackText,
  resolveFeishuRichReply,
  withinCardTableLimit,
} from "./presentation-card.js";
import {
  createFeishuPartialReplyDeliveryError,
  createFeishuReplyDeliveryResult,
  type FeishuReplyDeliverySource,
} from "./reply-delivery-result.js";
import { withFeishuSendContext } from "./send-context.js";
import {
  chunkFeishuCardMarkdown,
  sendCardFeishu,
  sendMessageFeishu,
  sendStructuredCardFeishu,
  type CardHeaderConfig,
} from "./send.js";

// Preserve direct-send upload failures through the shared payload fallback contract.
export const FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER = "__openclawPropagateMediaUploadFailure";
const FEISHU_TEXT_CHUNK_LIMIT = 4000;

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) {
    return null;
  }

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) {
    return null;
  }

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {
    return null;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
  const isImageExt = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".heic",
    ".tif",
    ".tiff",
  ].includes(ext);
  if (!isImageExt) {
    return null;
  }

  if (!path.isAbsolute(raw)) {
    return null;
  }
  try {
    const stat = statRegularFileSync(raw);
    if (stat.missing) {
      return null;
    }
  } catch {
    return null;
  }

  return raw;
}

type FeishuOutboundPayload = Parameters<
  NonNullable<ChannelOutboundAdapter["sendPayload"]>
>[0]["payload"];
type FeishuSendPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
type FeishuSendTextContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

// Direct sends surface upload failure; normal replies may deliver a text fallback.
export type FeishuOutboundSendMedia = (
  params: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0] & {
    propagateMediaUploadFailure?: boolean;
  },
) => ReturnType<NonNullable<ChannelOutboundAdapter["sendMedia"]>>;

function toFeishuOutboundResult<T extends { chatId: string }>(result: T) {
  const { chatId, ...delivery } = result;
  return { ...delivery, target: { kind: "chat" as const, id: chatId } };
}

async function reportFeishuOutboundDelivery<T extends { messageId: string; chatId: string }>(
  result: T,
  onDeliveryResult: FeishuSendTextContext["onDeliveryResult"],
): Promise<T> {
  await onDeliveryResult?.(attachChannelToResult("feishu", toFeishuOutboundResult(result)));
  return result;
}

function aggregateFeishuSendResult<T extends FeishuReplyDeliverySource>(
  result: T,
  results: readonly FeishuReplyDeliverySource[],
) {
  return {
    ...result,
    receipt: {
      ...createMessageReceiptFromOutboundResults({ results }),
      // Keep the established edit/reply target while retaining every physical send.
      primaryPlatformMessageId: result.messageId,
    },
  };
}

function partialFeishuSendError(error: unknown, results: readonly FeishuReplyDeliverySource[]) {
  if (results.length === 0 && error instanceof Error) {
    return error;
  }
  const accepted = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
  return createFeishuPartialReplyDeliveryError(error, {
    ...accepted,
    ...createFeishuReplyDeliveryResult({
      results: [...results, accepted],
      visibleReplySent: results.length > 0 || accepted !== undefined,
    }),
  });
}

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

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
  replyToIdSource?: FeishuSendTextContext["replyToIdSource"];
  replyToMode?: FeishuSendTextContext["replyToMode"];
  onDeliveryResult?: FeishuSendTextContext["onDeliveryResult"];
  header?: CardHeaderConfig;
}) {
  const { cfg, to, text, accountId, replyToMessageId, replyInThread, onDeliveryResult } = params;
  const commentResult = await sendCommentThreadReply({
    cfg,
    to,
    text,
    replyId: replyToMessageId,
    accountId,
  });
  if (commentResult) {
    return await reportFeishuOutboundDelivery(commentResult, onDeliveryResult);
  }

  const account = resolveFeishuAccount({ cfg, accountId });
  const renderMode = account.config?.renderMode ?? "auto";

  // Decide card routing on the original text so card content is never
  // modified by post-md newline normalization. Only the post path below
  // materializes CommonMark soft breaks for Feishu rendering.
  const useCard =
    (renderMode === "card" || (renderMode === "auto" && shouldUseFeishuCard(text))) &&
    withinCardTableLimit(text);

  // Tables need contiguous source rows, so convert them before the parser
  // materializes prose soft breaks for Feishu post rendering.
  const tableMode = resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const normalizedText = useCard
    ? text
    : materializeFeishuPostMarkdownSoftBreaks(convertMarkdownTables(text, tableMode));

  // Core chunks raw text before channel rendering. Re-chunk after expansion
  // and keep each fenced-code chunk independently valid Markdown.
  const postLimit = resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: FEISHU_TEXT_CHUNK_LIMIT,
  });
  const chunkOptions = {
    text: normalizedText,
    limit: postLimit,
    mode: resolveChunkMode(cfg, "feishu", accountId),
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
  for (const [i, chunk] of (subChunks.length ? subChunks : [normalizedText]).entries()) {
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
      await reportFeishuOutboundDelivery(result, onDeliveryResult);
    } catch (error) {
      throw partialFeishuSendError(error, results);
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
      adapter: feishuOutbound,
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
    lastResult = await sendMedia({
      ...ctx,
      text: "",
      mediaUrl,
      replyToId: nextReplyToId(),
      audioAsVoice: params.payload.audioAsVoice ?? ctx.audioAsVoice,
      ...(propagateMediaUploadFailure ? { propagateMediaUploadFailure: true } : {}),
    });
  }
  for (const chunk of textChunks) {
    lastResult = await sendText({
      ...ctx,
      text: chunk,
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
    for (const chunk of chunkFeishuMarkdown(text, FEISHU_TEXT_CHUNK_LIMIT)) {
      lastResult = await sendText({
        ...ctx,
        text: chunk,
        replyToId: nextReplyToId(),
      });
    }
  }

  for (const mediaUrl of normalizeStringEntries(resolvePayloadMediaUrls(params.payload))) {
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

function withFeishuOutboundSendContext(adapter: ChannelOutboundAdapter): ChannelOutboundAdapter {
  const { sendText, sendMedia, sendPayload } = adapter;
  return {
    ...adapter,
    ...(sendText
      ? { sendText: async (ctx) => withFeishuSendContext(ctx, () => sendText(ctx)) }
      : {}),
    ...(sendMedia
      ? { sendMedia: async (ctx) => withFeishuSendContext(ctx, () => sendMedia(ctx)) }
      : {}),
    ...(sendPayload
      ? { sendPayload: async (ctx) => withFeishuSendContext(ctx, () => sendPayload(ctx)) }
      : {}),
  };
}

export const feishuOutbound: ChannelOutboundAdapter = withFeishuOutboundSendContext({
  deliveryMode: "direct",
  chunker: chunkFeishuMarkdown,
  chunkerMode: "markdown",
  textChunkLimit: FEISHU_TEXT_CHUNK_LIMIT,
  presentationCapabilities: FEISHU_PRESENTATION_CAPABILITIES,
  renderPresentation: renderFeishuPresentationPayload,
  sendPayload: async (ctx) => {
    const { payload, presentationFallback } = consumeFeishuPresentationFallbackMarker(ctx.payload);
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
    });
    if (!card) {
      const { presentation } = resolveFeishuRichReply(payload);
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
        : payload;
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
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      replyToIdSource,
      replyToMode,
      threadId,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      identity,
      onDeliveryResult,
    }) => {
      const { replyToMessageId, replyInThread } = resolveFeishuReplyMode({
        replyToId,
        threadId,
      });
      const deliveryOptions = { replyToIdSource, replyToMode, onDeliveryResult };
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
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      audioAsVoice,
      accountId,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      replyToId,
      replyToIdSource,
      replyToMode,
      threadId,
      onDeliveryResult,
      propagateMediaUploadFailure = false,
    }: Parameters<FeishuOutboundSendMedia>[0]) => {
      const nextReplyToId = createFeishuReplyFanout({
        replyToId,
        threadId,
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
      const deliveryOptions = { replyToIdSource, replyToMode, onDeliveryResult };
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
