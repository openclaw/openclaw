import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import {
  isReasoningReplyPayload,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { WhatsAppSendDropReason, WhatsAppSendResult } from "../inbound/send-result.js";
import { listWhatsAppSendResultMessageIds } from "../inbound/send-result.js";
import { loadWebMedia } from "../media.js";
import {
  type DeliverableWhatsAppOutboundPayload,
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadTextPreservingIndentation,
  prepareWhatsAppOutboundMedia,
  sendWhatsAppOutboundWithRetry,
} from "../outbound-media-contract.js";
import { buildQuotedMessageOptions, lookupInboundMessageMeta } from "../quoted-message.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { convertMarkdownTables } from "../text-runtime.js";
import { markdownToWhatsApp } from "../text-runtime.js";
import { whatsappOutboundLog } from "./loggers.js";
import type { WebInboundMsg } from "./types.js";
import { elide } from "./util.js";

export type WhatsAppReplyDeliveryResult = {
  results: WhatsAppSendResult[];
  receipt: MessageReceipt;
  /** True when at least one chunk was accepted by the provider. False for both
   * transport failures and intentional policy drops — use dropReason to distinguish. */
  providerAccepted: boolean;
  /** Set when providerAccepted is false and every result was a policy drop
   * rather than a transport failure. Absence with providerAccepted false means
   * an actual transport failure. */
  dropReason?: WhatsAppSendDropReason;
};

function resolveWhatsAppReceiptKind(
  results: readonly WhatsAppSendResult[],
): Parameters<typeof createMessageReceiptFromOutboundResults>[0]["kind"] {
  if (results.length > 0 && results.every((result) => result.kind === "text")) {
    return "text";
  }
  if (results.length > 0 && results.every((result) => result.kind === "media")) {
    return "media";
  }
  return "unknown";
}

function createWhatsAppReplyDeliveryReceipt(
  results: readonly WhatsAppSendResult[],
): MessageReceipt {
  const receiptResultsById = new Map<string, MessageReceiptSourceResult>();
  for (const result of results) {
    if (result.receipt?.parts.length) {
      for (const part of result.receipt.parts) {
        receiptResultsById.set(part.platformMessageId, {
          ...(part.raw ?? { channel: "whatsapp", messageId: part.platformMessageId }),
          meta: {
            ...part.raw?.meta,
            kind: result.kind,
            providerAccepted: result.providerAccepted,
          },
        });
      }
      continue;
    }
    for (const messageId of listWhatsAppSendResultMessageIds(result)) {
      receiptResultsById.set(messageId, {
        channel: "whatsapp",
        messageId,
        meta: {
          kind: result.kind,
          providerAccepted: result.providerAccepted,
        },
      });
    }
  }
  return createMessageReceiptFromOutboundResults({
    results: [...receiptResultsById.values()],
    kind: resolveWhatsAppReceiptKind(results),
  });
}

function markWhatsAppVisibleDeliveryError(error: unknown): unknown {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    try {
      Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
      return error;
    } catch {
      // Fall back to a wrapper when a platform error object is non-extensible.
    }
  }
  const visibleError = new Error("visible WhatsApp reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
  msg: WebInboundMsg;
  mediaLocalRoots?: readonly string[];
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    debug: (obj: unknown, msg: string) => void;
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
  connectionId?: string;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
}): Promise<WhatsAppReplyDeliveryResult> {
  const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
  const replyStarted = Date.now();
  const sendResults: WhatsAppSendResult[] = [];
  const rememberSendResult = (result: WhatsAppSendResult | undefined) => {
    if (result) {
      sendResults.push(result);
    }
  };
  const finishDelivery = (): WhatsAppReplyDeliveryResult => {
    const receipt = createWhatsAppReplyDeliveryReceipt(sendResults);
    const anyAccepted = sendResults.some((result) => result.providerAccepted);
    // Propagate dropReason only when nothing was accepted and all results share
    // the same drop reason — that means the whole delivery was a policy drop,
    // not a partial or genuine transport failure.
    const dropReason =
      !anyAccepted &&
      sendResults.length > 0 &&
      sendResults.every(
        (r) => r.dropReason !== undefined && r.dropReason === sendResults[0]?.dropReason,
      )
        ? sendResults[0]?.dropReason
        : undefined;
    return {
      results: sendResults,
      receipt,
      providerAccepted: anyAccepted,
      ...(dropReason !== undefined ? { dropReason } : {}),
    };
  };
  if (isReasoningReplyPayload(replyResult)) {
    whatsappOutboundLog.debug(`Suppressed reasoning payload to ${msg.from}`);
    return finishDelivery();
  }
  const tableMode = params.tableMode ?? "code";
  const chunkMode = params.chunkMode ?? "length";
  const normalizedReply =
    params.normalizedReplyResult ??
    normalizeWhatsAppOutboundPayload(replyResult, {
      normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation,
    });
  const convertedText = markdownToWhatsApp(
    convertMarkdownTables(normalizedReply.text ?? "", tableMode),
  );
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = normalizedReply.mediaUrls ?? [];

  const getQuote = () => {
    if (!replyResult.replyToId) {
      return undefined;
    }
    // Use replyToId (not msg.id) so batched payloads quote the correct
    // per-message target.  Look up cached metadata for the specific
    // message being quoted — msg.body may be a combined batch body.
    const cached = lookupInboundMessageMeta(msg.accountId, msg.chatId, replyResult.replyToId);
    return buildQuotedMessageOptions({
      messageId: replyResult.replyToId,
      remoteJid: msg.chatId,
      fromMe: cached?.fromMe ?? false,
      participant: cached?.participant ?? (msg.chatType === "group" ? msg.senderJid : undefined),
      messageText: cached?.body ?? "",
    });
  };

  const sendWithRetry = async <T>(fn: () => Promise<T>, label: string, maxAttempts = 3) => {
    try {
      return await sendWhatsAppOutboundWithRetry({
        send: fn,
        maxAttempts,
        onRetry: ({ attempt, maxAttempts: retryMaxAttempts, backoffMs, errorText }) => {
          logVerbose(
            `Retrying ${label} to ${msg.from} after failure (${attempt}/${retryMaxAttempts - 1}) in ${backoffMs}ms: ${errorText}`,
          );
        },
      });
    } catch (error: unknown) {
      if (sendResults.some((result) => result.providerAccepted)) {
        throw markWhatsAppVisibleDeliveryError(error);
      }
      throw error;
    }
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      const quote = getQuote();
      rememberSendResult(await sendWithRetry(() => msg.reply(chunk, quote), "text"));
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    const delivery = finishDelivery();
    const logPayload = {
      correlationId: msg.id ?? newConnectionId(),
      connectionId: connectionId ?? null,
      to: msg.from,
      from: msg.to,
      text: elide(replyResult.text, 240),
      mediaUrl: null,
      mediaSizeBytes: null,
      mediaKind: null,
      durationMs: Date.now() - replyStarted,
    };
    if (delivery.providerAccepted) {
      replyLogger.info(logPayload, "auto-reply sent (text)");
    } else if (delivery.dropReason) {
      replyLogger.info(logPayload, `auto-reply text suppressed (${delivery.dropReason})`);
    } else {
      replyLogger.warn(logPayload, "auto-reply text was not accepted by WhatsApp provider");
    }
    return delivery;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  const leadingCaption = remainingText.shift() || "";
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
      const media = await prepareWhatsAppOutboundMedia(
        await loadWebMedia(mediaUrl, {
          maxBytes: maxMediaBytes,
          localRoots: params.mediaLocalRoots,
        }),
        mediaUrl,
      );
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
      }
      let primarySendResult: WhatsAppSendResult | undefined;
      if (media.kind === "image") {
        const quote = getQuote();
        primarySendResult = await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                image: media.buffer,
                caption,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:image",
        );
        rememberSendResult(primarySendResult);
      } else if (media.kind === "audio") {
        const quote = getQuote();
        primarySendResult = await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                audio: media.buffer,
                ptt: true,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:audio",
        );
        rememberSendResult(primarySendResult);
        if (caption) {
          rememberSendResult(
            await sendWithRetry(() => msg.reply(caption, quote), "media:audio-text"),
          );
        }
      } else if (media.kind === "video") {
        const quote = getQuote();
        primarySendResult = await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                video: media.buffer,
                caption,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:video",
        );
        rememberSendResult(primarySendResult);
      } else {
        const quote = getQuote();
        primarySendResult = await sendWithRetry(
          () =>
            msg.sendMedia(
              {
                document: media.buffer,
                fileName: media.fileName,
                caption,
                mimetype: media.mimetype,
              },
              quote,
            ),
          "media:document",
        );
        rememberSendResult(primarySendResult);
      }
      const mediaLogPayload = {
        correlationId: msg.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: msg.from,
        from: msg.to,
        text: caption ?? null,
        mediaUrl,
        mediaSizeBytes: media.buffer.length,
        mediaKind: media.kind,
        durationMs: Date.now() - replyStarted,
      };
      if (primarySendResult?.providerAccepted) {
        whatsappOutboundLog.info(
          `Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
        );
        replyLogger.info(mediaLogPayload, "auto-reply sent (media)");
      } else if (primarySendResult?.dropReason) {
        replyLogger.info(
          { ...mediaLogPayload, dropReason: primarySendResult.dropReason },
          `auto-reply media suppressed (${primarySendResult.dropReason})`,
        );
      }
    },
    onError: async ({ error, mediaUrl, caption, isFirst }) => {
      whatsappOutboundLog.error(`Failed sending web media to ${msg.from}: ${formatError(error)}`);
      replyLogger.warn({ err: error, mediaUrl }, "failed to send web media reply");
      if (!isFirst) {
        return;
      }
      const warning = "⚠️ Media failed.";
      const fallbackTextParts = [remainingText.shift() ?? caption ?? "", warning].filter(Boolean);
      const fallbackText = fallbackTextParts.join("\n");
      if (!fallbackText) {
        return;
      }
      whatsappOutboundLog.warn(`Media skipped; sent text-only to ${msg.from}`);
      rememberSendResult(
        await sendWithRetry(() => msg.reply(fallbackText, getQuote()), "media:fallback-text"),
      );
    },
  });

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    rememberSendResult(await sendWithRetry(() => msg.reply(chunk, getQuote()), "media:text"));
  }
  return finishDelivery();
}
