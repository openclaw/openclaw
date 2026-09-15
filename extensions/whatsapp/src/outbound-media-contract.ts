// Whatsapp plugin module implements outbound media contract behavior.
import path from "node:path";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
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

const mediaLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound-media");

/**
 * Test-only handle to the outbound-media subsystem logger. The voice-delivery
 * test suite spies on this to verify the sanitized fallback warning without
 * pulling in `setLoggerOverride` (which writes to a file sink by default).
 *
 * Tracked as a test-only export in `config/knip.all-exports.config.ts`.
 */
export const mediaLogForTest = mediaLog;

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
    // Entrada arbitrária (MP3, M4A, WebM...): mantém o teto de duração como
    // proteção contra arquivos malformados/abusivos.
    const buffer = await transcodeToWhatsAppVoiceOpus({
      buffer: media.buffer,
      fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "audio",
      maxDurationSeconds: MEDIA_FFMPEG_MAX_AUDIO_DURATION_SECS,
    });
    return { buffer, kind: "audio", mimetype: WHATSAPP_VOICE_MIMETYPE };
  }
  // Segundo: é Ogg/Opus por tipo, mas se a taxa real (OpusHead) não é 16 kHz
  // (ex.: TTS MiniMax 48 kHz), também transcodifica — WhatsApp mobile não toca 48 kHz.
  const inputRate = media.buffer ? getOpusInputRate(media.buffer) : undefined;
  if (inputRate !== undefined && inputRate !== WHATSAPP_VOICE_SAMPLE_RATE_HZ) {
    // Áudio nativo Ogg/Opus com taxa incompatível: NÃO aplica teto de duração.
    // O arquivo já era um voice note válido; cortar a 20 min introduziria perda
    // silenciosa de conteúdo num fluxo que antes passava intacto.
    try {
      const buffer = await transcodeToWhatsAppVoiceOpus({
        buffer: media.buffer,
        fileName: media.fileName ?? deriveWhatsAppDocumentFileName(mediaUrl) ?? "audio",
      });
      return { buffer, kind: "audio", mimetype: WHATSAPP_VOICE_MIMETYPE };
    } catch (error) {
      // FFmpeg ausente ou falhou: preservar a entrega nativa como antes desta
      // expansão — instalação sem ffmpeg não pode perder notas de voz que
      // Web/Desktop tocavam sem problema. Mas o runFfmpeg define logOutput:
      // false e a resolução de binário ausente lança sem logar, então o
      // usuário precisa de um sinal visível de que a conversão foi pulada
      // (WhatsApp mobile pode reter o playback bug sem indicação).
      mediaLog.warn(
        "WhatsApp voice transcoding skipped (ffmpeg unavailable or failed); " +
          "delivering native Ogg/Opus unchanged. WhatsApp mobile may reject the note.",
        { reason: error instanceof Error ? error.message : String(error) },
      );
      return normalized;
    }
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
  /** Teto de duração repassado ao ffmpeg; omitido preserva a duração completa. */
  maxDurationSeconds?: number;
}): Promise<Buffer> {
  const transcoded = await transcodeAudioBufferToOpus({
    audioBuffer: params.buffer,
    inputFileName: params.fileName,
    tempPrefix: "whatsapp-voice-",
    outputFileName: WHATSAPP_VOICE_FILE_NAME,
    maxDurationSeconds: params.maxDurationSeconds,
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
  const nSegs = buf.readUInt8(26);
  const bodyStart = 27 + nSegs;
  if (buf.subarray(bodyStart, bodyStart + 8).toString("ascii") !== "OpusHead") {
    return undefined;
  }
  // OpusHead: assinatura (8) + version (1) + channels (1) + pre-skip (2) +
  // input sample rate (4). Buffer que termina no meio do campo é cabeçalho
  // desconhecido (undefined), não erro — áudio truncado passa intacto em vez
  // de lançar exceção no readUInt32LE.
  if (buf.length < bodyStart + 16) {
    return undefined;
  }
  return buf.readUInt32LE(bodyStart + 12);
}

// Ogg/Opus minimal vendor-tag patch: reescreve apenas a página OpusTags,
// trocando o vendor para "WhatsApp" e zerando comentários. Todas as outras
// páginas (OpusHead + áudio) ficam byte a byte intactas; CRC Ogg recalculado.
function fixWhatsAppOpusVendor(buf: Buffer): Buffer {
  const POLY = 0x04c11db7;
  const table = Array.from({ length: 256 }, (_, i) => {
    let r = (i << 24) >>> 0;
    for (let j = 0; j < 8; j++) {
      r = (r & 0x80000000) !== 0 ? (((r << 1) >>> 0) ^ POLY) >>> 0 : (r << 1) >>> 0;
    }
    return r >>> 0;
  });
  const oggCrc = (data: Buffer): number => {
    let c = 0;
    for (const byte of data) {
      const idx = ((c >>> 24) ^ byte) & 0xff;
      c = (((c << 8) >>> 0) ^ (table[idx] ?? 0)) >>> 0;
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
    laces: number[];
    body: Buffer;
    raw: Buffer;
  }> = [];
  let off = 0;
  while (off + 27 <= buf.length && buf.subarray(off, off + 4).toString("ascii") === "OggS") {
    const htype = buf.readUInt8(off + 5);
    const granule = buf.readBigUInt64LE(off + 6);
    const serial = buf.readUInt32LE(off + 14);
    const seq = buf.readUInt32LE(off + 18);
    const nSegs = buf.readUInt8(off + 26);
    const laces = Array.from(buf.subarray(off + 27, off + 27 + nSegs));
    const bodyLen = laces.reduce((a, b) => a + b, 0);
    const body = buf.subarray(off + 27 + nSegs, off + 27 + nSegs + bodyLen);
    pages.push({
      htype,
      granule,
      serial,
      seq,
      laces,
      body,
      raw: buf.subarray(off, off + 27 + nSegs + bodyLen),
    });
    off += 27 + nSegs + bodyLen;
  }

  // O pacote OpusTags começa no início de uma página (sem flag de continuação).
  let tagsPage = -1;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (
      p !== undefined &&
      (p.htype & 0x01) === 0 &&
      p.body.length >= 8 &&
      p.body.subarray(0, 8).toString("ascii") === "OpusTags"
    ) {
      tagsPage = i;
      break;
    }
  }
  if (tagsPage === -1) {
    return buf;
  }

  // Descobrir a extensão do pacote: um lace < 255 encerra o pacote; laces de
  // 255 continuam para a próxima página. Arquivo truncado no meio do pacote
  // retorna intacto (nunca produzir framing parcial).
  let endPage = tagsPage;
  let endLace = -1;
  outer: for (let i = tagsPage; i < pages.length; i++) {
    const p = pages[i];
    if (p === undefined) {
      break;
    }
    for (let j = 0; j < p.laces.length; j++) {
      const laceLen = p.laces[j];
      if (laceLen !== undefined && laceLen < 255) {
        endPage = i;
        endLace = j;
        break outer;
      }
    }
  }
  if (endLace === -1) {
    return buf;
  }

  const vendor = Buffer.from("WhatsApp");
  const newBody = Buffer.concat([Buffer.from("OpusTags"), u32(vendor.length), vendor, u32(0)]);
  const newLaces = lace(newBody);

  // Montar a saída: páginas anteriores intactas, pacote OpusTags substituído
  // por uma única página curta, páginas do pacote antigo descartadas, e a cauda
  // (se o pacote terminava no meio de uma página) promovida a nova página que
  // começa o próximo pacote.
  type OutPage = {
    htype: number;
    granule: bigint;
    serial: number;
    seq: number;
    laces: number[];
    body: Buffer;
    raw?: Buffer;
  };
  const out: OutPage[] = [];
  for (let i = 0; i < tagsPage; i++) {
    const p = pages[i];
    if (p === undefined) {
      continue;
    }
    out.push({
      htype: p.htype,
      granule: p.granule,
      serial: p.serial,
      seq: p.seq,
      laces: p.laces,
      body: p.body,
      raw: p.raw,
    });
  }
  const tagsSource = pages[tagsPage];
  if (tagsSource === undefined) {
    return buf;
  }
  out.push({
    htype: 0x00,
    // Página de cabeçalho concluída: RFC 7845 §4 exige granule position 0.
    // Página contendo só pacote inacabado carrega all-ones (-1), que não pode
    // ser copiado para o cabeçalho reescrito (invalidaria a nota de voz).
    granule: 0n,
    serial: tagsSource.serial,
    seq: -1,
    laces: newLaces,
    body: newBody,
  });
  const endSource = pages[endPage];
  if (endSource !== undefined && endLace + 1 < endSource.laces.length) {
    const tailLaces = endSource.laces.slice(endLace + 1);
    const tailOffset = endSource.laces.slice(0, endLace + 1).reduce((a, b) => a + b, 0);
    out.push({
      htype: 0x00, // começa um pacote novo na primeira lace da cauda
      granule: endSource.granule,
      serial: endSource.serial,
      seq: -1,
      laces: tailLaces,
      body: endSource.body.subarray(tailOffset),
    });
  }
  for (let i = endPage + 1; i < pages.length; i++) {
    const p = pages[i];
    if (p === undefined) {
      continue;
    }
    out.push({
      htype: p.htype,
      granule: p.granule,
      serial: p.serial,
      seq: p.seq,
      laces: p.laces,
      body: p.body,
      raw: p.raw,
    });
  }

  // Numerar as sequências por serial (a remoção de páginas desloca os números)
  // e concatenar todos os blocos uma única vez (sem cópia O(n²) no loop).
  const nextSeqBySerial = new Map<number, number>();
  const chunks: Buffer[] = [];
  for (const entry of out) {
    const nextSeq = nextSeqBySerial.get(entry.serial) ?? 0;
    nextSeqBySerial.set(entry.serial, nextSeq + 1);
    if (entry.raw !== undefined && entry.seq === nextSeq) {
      chunks.push(entry.raw);
    } else {
      chunks.push(
        makePage(entry.htype, entry.granule, entry.serial, nextSeq, entry.laces, entry.body),
      );
    }
  }
  return Buffer.concat(chunks);
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
