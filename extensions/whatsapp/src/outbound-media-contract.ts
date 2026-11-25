import path from "node:path";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import {
  mediaKindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "openclaw/plugin-sdk/media-mime";
import type { MediaKind } from "openclaw/plugin-sdk/media-mime";
import {
  MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
  transcodeAudioBufferToOpus,
} from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { normalizeUniqueStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripToolCallXmlTags,
} from "openclaw/plugin-sdk/text-chunking";
import { resolveWhatsAppDocumentFileName } from "./document-filename.js";

type WhatsAppOutboundPayloadLike = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: readonly string[];
};

type WhatsAppLoadedMediaLike = {
  buffer: Buffer;
  contentType?: string;
  kind?: string;
  fileName?: string;
};

type NormalizedWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike> = Omit<
  T,
  "text" | "mediaUrl" | "mediaUrls"
> & {
  text: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

export type DeliverableWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike> = Omit<
  NormalizedWhatsAppOutboundPayload<T>,
  "text"
> & {
  text?: string;
};

type CanonicalWhatsAppLoadedMedia = {
  buffer: Buffer;
  kind: Exclude<MediaKind, "sticker" | "unknown">;
  mimetype: string;
  fileName?: string;
};

const WHATSAPP_VOICE_FILE_NAME = "voice.ogg";
const WHATSAPP_VOICE_SAMPLE_RATE_HZ = 48_000;
const WHATSAPP_VOICE_BITRATE = "64k";
const WHATSAPP_VOICE_MIMETYPE = "audio/ogg; codecs=opus";

function finalizeWhatsAppVisibleText(text: string): string {
  return sanitizeForPlainText(stripToolCallXmlTags(text, { stripFunctionCallsXmlPayloads: true }));
}

export function normalizeWhatsAppPayloadText(text: string | undefined): string {
  return finalizeWhatsAppVisibleText(sanitizeAssistantVisibleText(text ?? "")).trimStart();
}

function stripLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "");
}

export function normalizeWhatsAppPayloadTextPreservingIndentation(
  text: string | undefined,
): string {
  const sanitized = sanitizeAssistantVisibleTextWithProfile(
    stripLeadingBlankLines(text ?? ""),
    "history",
  );
  const normalized = stripLeadingBlankLines(finalizeWhatsAppVisibleText(sanitized));
  return normalized.trim() ? normalized : "";
}

// The direct API accepts both fields as additive candidates, with mediaUrl first.
// Keep that contract separate from channel ReplyPayload mediaUrls precedence.
export function resolveAdditiveWhatsAppMediaUrls(
  payload: Pick<WhatsAppOutboundPayloadLike, "mediaUrl" | "mediaUrls">,
): string[] {
  return normalizeUniqueStringEntries([
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ...(payload.mediaUrls ?? []),
  ]);
}

// Keep new WhatsApp outbound-media behavior in this helper so payload, gateway, and auto-reply paths stay aligned.
export function normalizeWhatsAppOutboundPayload<T extends WhatsAppOutboundPayloadLike>(
  payload: T,
  options?: {
    normalizeText?: (text: string | undefined) => string;
  },
): NormalizedWhatsAppOutboundPayload<T> {
  const preferredMediaUrls = normalizeUniqueStringEntries(payload.mediaUrls);
  const mediaUrls = normalizeUniqueStringEntries(
    resolveOutboundMediaUrls({ mediaUrl: payload.mediaUrl, mediaUrls: preferredMediaUrls }),
  );
  const normalizeText = options?.normalizeText ?? normalizeWhatsAppPayloadText;
  return {
    ...payload,
    text: normalizeText(payload.text),
    mediaUrl: mediaUrls[0],
    mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
  };
}

function inferWhatsAppMediaKind(
  media: WhatsAppLoadedMediaLike,
  resolvedContentType?: string,
): CanonicalWhatsAppLoadedMedia["kind"] {
  // Generic binary responses are initially classified as documents; let a
  // real filename recover their native family instead of preserving that guess.
  const isGenericDocument =
    media.kind === "document" &&
    normalizeMimeType(media.contentType) === "application/octet-stream";
  if (
    media.kind === "image" ||
    media.kind === "audio" ||
    media.kind === "video" ||
    (media.kind === "document" && !isGenericDocument)
  ) {
    return media.kind;
  }
  const inferredKind = mediaKindFromMime(normalizeMimeType(resolvedContentType));
  return !inferredKind || inferredKind === "sticker" || inferredKind === "unknown"
    ? "document"
    : inferredKind;
}

export async function prepareWhatsAppOutboundMedia(
  media: WhatsAppLoadedMediaLike,
  mediaUrl?: string,
): Promise<CanonicalWhatsAppLoadedMedia> {
  // Infer the kind and native payload MIME from the same filename fact; Baileys
  // does not replace an explicit application/octet-stream on images or videos.
  const filenameMimeType = mimeTypeFromFilePath(media.fileName);
  const normalizedContentType = normalizeMimeType(media.contentType);
  const resolvedContentType =
    !normalizedContentType || normalizedContentType === "application/octet-stream"
      ? (filenameMimeType ?? normalizedContentType)
      : normalizedContentType;
  const kind = inferWhatsAppMediaKind(media, resolvedContentType);
  const nativeVoice = kind === "audio" && isWhatsAppNativeVoiceAudio(media.buffer);
  const mimetype = nativeVoice
    ? WHATSAPP_VOICE_MIMETYPE
    : (resolvedContentType ?? "application/octet-stream");
  const fileName =
    kind === "document"
      ? resolveWhatsAppDocumentFileName({
          fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl),
          mimetype,
        })
      : media.fileName;
  const normalized = {
    buffer: media.buffer,
    kind,
    mimetype,
    ...(fileName ? { fileName } : {}),
  };
  if (kind !== "audio" || nativeVoice) {
    return normalized;
  }

  const buffer = await transcodeAudioBufferToOpus({
    audioBuffer: media.buffer,
    inputFileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "audio",
    tempPrefix: "whatsapp-voice-",
    outputFileName: WHATSAPP_VOICE_FILE_NAME,
    maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
    sampleRateHz: WHATSAPP_VOICE_SAMPLE_RATE_HZ,
    channels: 1,
    bitrate: WHATSAPP_VOICE_BITRATE,
  });
  return {
    buffer,
    kind: "audio",
    mimetype: WHATSAPP_VOICE_MIMETYPE,
  };
}

function isWhatsAppNativeVoiceAudio(buffer: Buffer): boolean {
  const segmentCount = buffer[26];
  if (!segmentCount || buffer.toString("latin1", 0, 4) !== "OggS") {
    return false;
  }
  // RFC 7845: the first Ogg page contains only the Opus identification packet.
  const packetOffset = 27 + segmentCount;
  return (
    buffer.length >= packetOffset + 19 &&
    buffer.toString("latin1", packetOffset, packetOffset + 8) === "OpusHead"
  );
}

function deriveWhatsAppDocumentFileName(mediaUrl: string | undefined): string | undefined {
  if (!mediaUrl) {
    return undefined;
  }
  try {
    const parsed = new URL(mediaUrl);
    const fileName = path.posix.basename(parsed.pathname);
    return fileName ? decodeURIComponent(fileName) : undefined;
  } catch {
    const withoutQueryOrFragment = mediaUrl.split(/[?#]/, 1)[0] ?? "";
    const fileName = withoutQueryOrFragment.split(/[\\/]/).pop();
    return fileName || undefined;
  }
}
