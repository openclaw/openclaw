// Whatsapp plugin module implements outbound media contract behavior.
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
import { resolveWhatsAppDocumentFileName } from "./document-filename.js";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripToolCallXmlTags,
} from "./text-runtime.js";

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
const WHATSAPP_VOICE_SAMPLE_RATE_HZ = 16_000;
const WHATSAPP_VOICE_BITRATE = "64k";
const WHATSAPP_VOICE_MIMETYPE = "audio/ogg; codecs=opus";

function stripWhatsAppPluralToolXml(text: string): string {
  return stripToolCallXmlTags(text, { stripFunctionCallsXmlPayloads: true });
}

function finalizeWhatsAppVisibleText(text: string): string {
  return sanitizeForPlainText(stripWhatsAppPluralToolXml(text));
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

function normalizeWhatsAppLoadedMedia(
  media: WhatsAppLoadedMediaLike,
  mediaUrl?: string,
): CanonicalWhatsAppLoadedMedia {
  // Infer the kind and native payload MIME from the same filename fact; Baileys
  // does not replace an explicit application/octet-stream on images or videos.
  const filenameMimeType = mimeTypeFromFilePath(media.fileName);
  const normalizedContentType = normalizeMimeType(media.contentType);
  const resolvedContentType =
    !normalizedContentType || normalizedContentType === "application/octet-stream"
      ? (filenameMimeType ?? normalizedContentType)
      : normalizedContentType;
  const kind = inferWhatsAppMediaKind(media, resolvedContentType);
  // Match the existing URL/filename voice rule used by the transcode decision;
  // otherwise native .ogg/.opus uploads carry an inconsistent payload MIME.
  const mimetype =
    kind === "audio" &&
    isWhatsAppNativeVoiceAudio({
      contentType: media.contentType,
      fileName: media.fileName,
      mediaUrl,
    })
      ? WHATSAPP_VOICE_MIMETYPE
      : (resolvedContentType ?? "application/octet-stream");
  const fileName =
    kind === "document"
      ? resolveWhatsAppDocumentFileName({
          fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl),
          mimetype,
        })
      : media.fileName;
  return {
    buffer: media.buffer,
    kind,
    mimetype,
    ...(fileName ? { fileName } : {}),
  };
}

export async function prepareWhatsAppOutboundMedia(
  media: WhatsAppLoadedMediaLike,
  mediaUrl?: string,
): Promise<CanonicalWhatsAppLoadedMedia> {
  const normalized = normalizeWhatsAppLoadedMedia(media, mediaUrl);
  if (normalized.kind !== "audio") {
    return normalized;
  }
  // Primeiro: se não é Ogg/Opus por MIME ou extensão, transcodifica.
  if (
    !isWhatsAppNativeVoiceAudio({
      contentType: media.contentType,
      fileName: media.fileName,
      mediaUrl,
    })
  ) {
    const buffer = await transcodeToWhatsAppVoiceOpus({
      buffer: media.buffer,
      fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "audio",
    });
    return { buffer, kind: "audio", mimetype: WHATSAPP_VOICE_MIMETYPE };
  }
  // Segundo: é Ogg/Opus por tipo, mas se a taxa real (OpusHead) não é 16 kHz
  // (ex.: TTS MiniMax 48 kHz), também transcodifica — WhatsApp mobile não toca 48 kHz.
  const inputRate = media.buffer ? getOpusInputRate(media.buffer) : undefined;
  if (inputRate !== undefined && inputRate !== WHATSAPP_VOICE_SAMPLE_RATE_HZ) {
    const buffer = await transcodeToWhatsAppVoiceOpus({
      buffer: media.buffer,
      fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "audio",
    });
    return { buffer, kind: "audio", mimetype: WHATSAPP_VOICE_MIMETYPE };
  }
  // É nativo de verdade (16 kHz): passa como está.
  return normalized;
}

function isWhatsAppNativeVoiceAudio(params: {
  contentType?: string;
  fileName?: string;
  mediaUrl?: string;
}): boolean {
  const contentType = normalizeMimeType(params.contentType);
  if (contentType === "audio/ogg" || contentType === "audio/opus") {
    return true;
  }
  const fileName = params.fileName ?? deriveWhatsAppDocumentFileName(params.mediaUrl) ?? "";
  const ext = path.extname(fileName).toLowerCase();
  return ext === ".ogg" || ext === ".opus";
}

async function transcodeToWhatsAppVoiceOpus(params: {
  buffer: Buffer;
  fileName: string;
}): Promise<Buffer> {
  const transcoded = await transcodeAudioBufferToOpus({
    audioBuffer: params.buffer,
    inputFileName: params.fileName,
    tempPrefix: "whatsapp-voice-",
    outputFileName: WHATSAPP_VOICE_FILE_NAME,
    maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
    sampleRateHz: WHATSAPP_VOICE_SAMPLE_RATE_HZ,
    channels: 1,
    bitrate: WHATSAPP_VOICE_BITRATE,
  });
  // O WhatsApp mobile exige a tag vendor "WhatsApp" nas OpusTags; o ffmpeg
  // grava "Lavf*", e sem isso o celular recusa a nota de voz ("áudio indisponível").
  return fixWhatsAppOpusVendor(transcoded);
}

function getOpusInputRate(buf: Buffer): number | undefined {
  // Lê o campo input sample rate do OpusHead (offset 12, uint32le) na primeira página Ogg.
  if (buf.length < 32 || buf.subarray(0, 4).toString("ascii") !== "OggS") {
    return undefined;
  }
  const nSegs = buf[26];
  const bodyStart = 27 + nSegs;
  if (buf.subarray(bodyStart, bodyStart + 8).toString("ascii") !== "OpusHead") {
    return undefined;
  }
  return buf.readUInt32LE(bodyStart + 12);
}

// Ogg/Opus minimal vendor-tag patch: reescreve apenas a página OpusTags,
// trocando o vendor para "WhatsApp" e zerando comentários. Todas as outras
// páginas (OpusHead + áudio) ficam byte a byte intactas; CRC Ogg recalculado.
function fixWhatsAppOpusVendor(buf: Buffer): Buffer {
  const POLY = 0x04c11db7;
  const table = new Array<number>(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r =
        (r & 0x80000000) !== 0
          ? (((r << 1) >>> 0) ^ POLY) >>> 0
          : ((r << 1) >>> 0);
    }
    table[i] = r >>> 0;
  }
  const oggCrc = (data: Buffer): number => {
    let c = 0;
    for (let i = 0; i < data.length; i++) {
      c = (((c << 8) >>> 0) ^ table[((c >>> 24) ^ data[i]) & 0xff]) >>> 0;
    }
    return c >>> 0;
  };
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
  };
  const lace = (blob: Buffer): number[] => {
    const l: number[] = [];
    let rest = blob;
    while (rest.length >= 255) {
      l.push(255);
      rest = rest.subarray(255);
    }
    l.push(rest.length);
    return l;
  };
  const makePage = (
    htype: number,
    granule: bigint,
    serial: number,
    seq: number,
    laces: number[],
    body: Buffer,
  ): Buffer => {
    const segTable = Buffer.from(laces);
    const h = Buffer.alloc(27 + segTable.length);
    h.write("OggS", 0, "ascii");
    h[5] = htype;
    h.writeBigUInt64LE(granule, 6);
    h.writeUInt32LE(serial >>> 0, 14);
    h.writeUInt32LE(seq >>> 0, 18);
    h[26] = segTable.length;
    segTable.copy(h, 27);
    const full = Buffer.concat([h, body]);
    full.writeUInt32LE(oggCrc(full), 22);
    return full;
  };

  const pages: Array<{
    htype: number;
    granule: bigint;
    serial: number;
    seq: number;
    body: Buffer;
    raw: Buffer;
  }> = [];
  let off = 0;
  while (
    off + 27 <= buf.length &&
    buf.subarray(off, off + 4).toString("ascii") === "OggS"
  ) {
    const htype = buf[off + 5];
    const granule = buf.readBigUInt64LE(off + 6);
    const serial = buf.readUInt32LE(off + 14);
    const seq = buf.readUInt32LE(off + 18);
    const nSegs = buf[off + 26];
    const segs = Array.from(buf.subarray(off + 27, off + 27 + nSegs));
    const bodyLen = segs.reduce((a, b) => a + b, 0);
    const body = buf.subarray(off + 27 + nSegs, off + 27 + nSegs + bodyLen);
    pages.push({
      htype,
      granule,
      serial,
      seq,
      body,
      raw: buf.subarray(off, off + 27 + nSegs + bodyLen),
    });
    off += 27 + nSegs + bodyLen;
  }

  let out = Buffer.alloc(0);
  let fixed = false;
  for (const p of pages) {
    if (
      !fixed &&
      p.body.length >= 8 &&
      p.body.subarray(0, 8).toString("ascii") === "OpusTags"
    ) {
      const vendor = Buffer.from("WhatsApp");
      const newBody = Buffer.concat([
        Buffer.from("OpusTags"),
        u32(vendor.length),
        vendor,
        u32(0),
      ]);
      out = Buffer.concat([
        out,
        makePage(p.htype, p.granule, p.serial, p.seq, lace(newBody), newBody),
      ]);
      fixed = true;
    } else {
      out = Buffer.concat([out, p.raw]);
    }
  }
  return fixed ? out : buf;
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
