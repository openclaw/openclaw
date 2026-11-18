import type { proto, WAMessage, WASocket } from "baileys";
import {
  formatInboundMediaUnavailableText,
  formatLocationText,
} from "openclaw/plugin-sdk/channel-inbound";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveWhatsAppMediaMaxBytes } from "../accounts.js";
import { getStatusCode } from "../session-errors.js";
import {
  describeReplyContext,
  extractContactContext,
  extractExternalAdReplyContext,
  extractLocationData,
  extractMediaKind,
  extractMentionedJids,
  extractText,
  projectWhatsAppInboundMessage,
} from "./extract.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadInboundMedia, downloadQuotedInboundMedia } from "./media.js";

const inboundMediaLogger = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");

function logMediaMaterializationFailure(params: {
  messageId?: string | null;
  mediaKind?: string;
  mimeType?: string;
  failureStage: "direct" | "quoted";
  error: unknown;
}): void {
  const errorName = params.error instanceof Error ? params.error.name : undefined;
  const errorClass =
    errorName &&
    ["AbortError", "TimeoutError", "TypeError", "RangeError", "SyntaxError"].includes(errorName)
      ? errorName
      : "Error";
  const statusCode = getStatusCode(params.error);
  const failureDetails = [
    `stage=${params.failureStage}`,
    `class=${errorClass}`,
    ...(params.mediaKind ? [`kind=${params.mediaKind}`] : []),
    ...(typeof statusCode === "number" ? [`status=${statusCode}`] : []),
  ].join(" ");
  // One subsystem event keeps the Gateway console and structured file log in sync.
  inboundMediaLogger.warn("WhatsApp inbound media materialization failed", {
    channel: "whatsapp",
    messageId: params.messageId ?? undefined,
    mediaKind: params.mediaKind,
    mimeType: params.mimeType,
    failureStage: params.failureStage,
    errorClass,
    ...(typeof statusCode === "number" ? { statusCode } : {}),
    consoleMessage: `WhatsApp inbound media materialization failed (${failureDetails})`,
  });
}

export async function enrichWhatsAppInboundMessage(params: {
  msg: WAMessage;
  sock: WASocket;
  mediaMaxMb?: number;
}) {
  const { msg, sock } = params;
  const messageProjection = projectWhatsAppInboundMessage(msg.message ?? undefined);
  const location = extractLocationData(messageProjection);
  const locationText = location ? formatLocationText(location) : undefined;
  const contactContext = extractContactContext(messageProjection);
  const externalAdReplyContext = extractExternalAdReplyContext(messageProjection);
  let mediaKind = extractMediaKind(messageProjection);
  let body = extractText(messageProjection);
  if (locationText) {
    body = [body, locationText].filter(Boolean).join("\n").trim();
  }
  if (!body && !mediaKind) {
    return null;
  }
  body = body ?? "";
  const commandBody = body;
  const replyContext = describeReplyContext(messageProjection);

  let mediaPath: string | undefined;
  let mediaType = mediaKind
    ? resolveInboundMediaMimetype(msg.message as proto.IMessage)
    : undefined;
  const nativeMedia = mediaKind ? { contentType: mediaType, kind: mediaKind } : undefined;
  let mediaFileName: string | undefined;
  let savedContentType: string | undefined;
  const maxBytes = resolveWhatsAppMediaMaxBytes(params);
  const saveInboundMedia = (inboundMedia: Awaited<ReturnType<typeof downloadInboundMedia>>) => {
    if (!inboundMedia) {
      return;
    }
    mediaPath = inboundMedia.saved.path;
    mediaType = inboundMedia.mimetype;
    mediaFileName = inboundMedia.fileName;
    savedContentType = inboundMedia.saved.contentType;
  };
  try {
    // Entry zero is exactly the Baileys normalization that downloadInboundMedia performed here
    // previously; later projection entries are extraction-only future-proof payloads.
    saveInboundMedia(
      await downloadInboundMedia(
        msg as proto.IWebMessageInfo,
        sock,
        maxBytes,
        messageProjection[0],
      ),
    );
  } catch (error) {
    logMediaMaterializationFailure({
      messageId: msg.key?.id,
      mediaKind,
      mimeType: mediaType,
      failureStage: "direct",
      error,
    });
    body = formatInboundMediaUnavailableText({
      body,
      notice: "[whatsapp attachment unavailable]",
    });
  }
  if (!mediaPath && !mediaKind && replyContext?.media) {
    try {
      saveInboundMedia(
        await downloadQuotedInboundMedia(msg as proto.IWebMessageInfo, sock, maxBytes),
      );
      mediaKind = replyContext.media.kind ?? undefined;
      mediaType = mediaType ?? replyContext.media.contentType ?? undefined;
    } catch (error) {
      logMediaMaterializationFailure({
        messageId: msg.key?.id,
        mediaKind: replyContext.media.kind ?? undefined,
        mimeType: replyContext.media.contentType ?? undefined,
        failureStage: "quoted",
        error,
      });
      body = formatInboundMediaUnavailableText({
        body,
        notice: "[whatsapp quoted attachment unavailable]",
      });
    }
  }

  if (mediaKind === "document" && savedContentType?.startsWith("image/")) {
    mediaKind = "image";
  }

  return {
    body,
    commandBody,
    location: location ?? undefined,
    contactContext,
    externalAdReplyContext,
    replyContext,
    mediaPath,
    mediaType,
    mediaFileName,
    mediaKind,
    nativeMedia,
    mentionedJids: extractMentionedJids(messageProjection),
  };
}
