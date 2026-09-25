import { randomUUID } from "node:crypto";
import { InputFile } from "grammy";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { isGifMedia, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { findMarkdownImageSpans } from "openclaw/plugin-sdk/text-chunking";
import { inputRichBlockMediaSources, isVoiceNoteMedia } from "./rich-block-model.js";
import {
  buildTelegramRichMarkdownPlan,
  telegramRichMediaReference,
  type TelegramInputRichMessageMedia,
} from "./rich-message.js";
import { buildOutboundMediaLoadOptions, getImageMetadata, loadWebMedia } from "./send.runtime.js";

const MAX_RICH_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_TELEGRAM_PHOTO_DIMENSION_SUM = 10_000;
const MAX_TELEGRAM_PHOTO_ASPECT_RATIO = 20;
const LOCAL_MEDIA_SOURCE_RE = /^(?:(?:[fF][iI][lL][eE]:\/\/)?\/(?!\/)|[A-Za-z]:[\\/])/u;
const LOCAL_MEDIA_TAG_RE =
  /<(img|video|audio)\b([^>]*?)\bsrc\s*=\s*(?:(["'])([^"']+)\3|([^\s"'=<>`]+))([^>]*)>/giu;

type RichMediaType = "photo" | "video" | "audio" | "voice_note";
type RichMediaElementType = Exclude<RichMediaType, "voice_note">;

export type TelegramRichLocalMedia = TelegramInputRichMessageMedia & {
  /** Original local source, resent as legacy media when Telegram rejects the rich upload. */
  source: string;
  fileName: string;
};

function unsupportedRichLocalMediaError(source: string): Error {
  return new Error(
    `Telegram rich messages can embed local photos, videos, and audio only: ${source}`,
  );
}

function isTelegramRichLocalMediaSource(source: string): boolean {
  return LOCAL_MEDIA_SOURCE_RE.test(source.trim());
}

function richMediaTypeForTag(tag: string): RichMediaElementType {
  const normalizedTag = tag.toLowerCase();
  return normalizedTag === "img" ? "photo" : normalizedTag === "video" ? "video" : "audio";
}

function richMediaElementType(type: RichMediaType): RichMediaElementType {
  return type === "voice_note" ? "audio" : type;
}

function richLocalMediaFilename(params: {
  fileName?: string;
  contentType?: string;
  type: RichMediaType;
}): string {
  if (params.fileName) {
    return params.fileName;
  }
  const extension =
    extensionForMime(params.contentType) ??
    (params.type === "photo" ? ".jpg" : params.type === "video" ? ".mp4" : ".ogg");
  return `${params.type}${extension}`;
}

async function isRichPhoto(media: { buffer: Buffer }): Promise<boolean> {
  if (media.buffer.length === 0 || media.buffer.length > MAX_RICH_PHOTO_BYTES) {
    return false;
  }
  try {
    const metadata = await getImageMetadata(media.buffer);
    const width = metadata?.width;
    const height = metadata?.height;
    if (typeof width !== "number" || typeof height !== "number") {
      return false;
    }
    const shorterSide = Math.min(width, height);
    const longerSide = Math.max(width, height);
    return (
      width + height <= MAX_TELEGRAM_PHOTO_DIMENSION_SUM &&
      shorterSide > 0 &&
      longerSide <= shorterSide * MAX_TELEGRAM_PHOTO_ASPECT_RATIO
    );
  } catch {
    return false;
  }
}

function buildFigure(
  source: string,
  type: RichMediaType,
  params?: { alt?: string; caption?: string },
) {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const alt = params?.alt ? ` alt="${escape(params.alt)}"` : "";
  const caption = params?.caption ? `<figcaption>${escape(params.caption)}</figcaption>` : "";
  const elementType = richMediaElementType(type);
  const tag = elementType === "photo" ? "img" : elementType;
  return `<figure><${tag} src="${source}"${alt}/>${caption}</figure>`;
}

export async function resolveTelegramRichLocalMedia(params: {
  text: string;
  tableMode?: MarkdownTableMode;
  skipEntityDetection?: boolean;
  mediaUrls?: readonly string[];
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<{
  text: string;
  media: TelegramRichLocalMedia[];
  unconsumedMediaUrls: string[];
}> {
  const media: TelegramRichLocalMedia[] = [];
  const cache = new Map<string, Promise<TelegramRichLocalMedia | undefined>>();
  let nextId = 0;
  const resolve = async (source: string) => {
    const key = source.trim();
    const cached = cache.get(key);
    if (cached) {
      return await cached;
    }
    const pending = (async () => {
      const loaded = await loadWebMedia(
        key,
        buildOutboundMediaLoadOptions({
          maxBytes: params.maxBytes,
          mediaAccess: params.mediaAccess,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
        }),
      );
      const kind = kindFromMime(loaded.contentType ?? undefined);
      const isGif = isGifMedia({ contentType: loaded.contentType, fileName: loaded.fileName });
      const type =
        kind === "image" && !isGif && (await isRichPhoto(loaded))
          ? "photo"
          : kind === "video" && !isGif
            ? "video"
            : kind === "audio"
              ? isVoiceNoteMedia(loaded.fileName ?? key)
                ? "voice_note"
                : "audio"
              : undefined;
      if (!type) {
        return undefined;
      }
      nextId += 1;
      const fileName = richLocalMediaFilename({
        fileName: loaded.fileName,
        contentType: loaded.contentType,
        type,
      });
      const entry: TelegramRichLocalMedia = {
        id: `media${nextId}`,
        source: key,
        fileName,
        media: { type, media: new InputFile(loaded.buffer, fileName) },
      };
      media.push(entry);
      return entry;
    })();
    cache.set(key, pending);
    return await pending;
  };

  // Discovery is text-only. The canonical rich parser decides which candidates
  // are media; code, unsupported HTML, and other literal examples never reach I/O.
  let prefix: string;
  do {
    prefix = `local_${randomUUID().replaceAll("-", "")}_`;
  } while (params.text.includes(prefix));
  type Candidate = {
    start: number;
    end: number;
    source: string;
    type: RichMediaElementType;
    reference: string;
    render: (reference: string, type: RichMediaType) => string;
    matchElement?: boolean;
  };
  const candidates: Candidate[] = [];
  for (const match of params.text.matchAll(LOCAL_MEDIA_TAG_RE)) {
    const [raw, tag = "", before = "", quote = "", quotedSource, unquotedSource, after = ""] =
      match;
    const source = quotedSource ?? unquotedSource ?? "";
    if (!isTelegramRichLocalMediaSource(source)) {
      continue;
    }
    const type = richMediaTypeForTag(tag);
    const outputQuote = quote || '"';
    candidates.push({
      start: match.index,
      end: match.index + raw.length,
      source,
      type,
      reference: `tg://${type}?id=${prefix}${candidates.length}`,
      render: (reference) =>
        `<${tag}${before}src=${outputQuote}${reference}${outputQuote}${after}>`,
      matchElement: true,
    });
  }
  for (const { start, end, destination: source, alt, title } of findMarkdownImageSpans(
    params.text,
  )) {
    if (
      !isTelegramRichLocalMediaSource(source) ||
      candidates.some((candidate) => start < candidate.end && end > candidate.start)
    ) {
      continue;
    }
    candidates.push({
      start,
      end,
      source,
      type: "photo",
      reference: `tg://photo?id=${prefix}${candidates.length}`,
      render: (reference, type) => buildFigure(reference, type, { alt, caption: title }),
    });
  }
  candidates.sort((a, b) => a.start - b.start);
  let discovery = "";
  let cursor = 0;
  for (const candidate of candidates) {
    discovery += params.text.slice(cursor, candidate.start);
    discovery += candidate.render(candidate.reference, candidate.type);
    cursor = candidate.end;
  }
  discovery += params.text.slice(cursor);
  const accepted = candidates.length
    ? inputRichBlockMediaSources(
        buildTelegramRichMarkdownPlan(discovery, {
          tableMode: params.tableMode,
          skipEntityDetection: params.skipEntityDetection,
        }).richMessage.blocks,
      )
    : new Set<string>();
  let markdown = "";
  cursor = 0;
  for (const candidate of candidates) {
    markdown += params.text.slice(cursor, candidate.start);
    cursor = candidate.end;
    if (!accepted.has(candidate.reference)) {
      markdown += params.text.slice(candidate.start, candidate.end);
      continue;
    }
    const resolved = await resolve(candidate.source);
    if (!resolved) {
      throw unsupportedRichLocalMediaError(candidate.source);
    }
    if (candidate.matchElement && richMediaElementType(resolved.media.type) !== candidate.type) {
      throw new Error(
        `Telegram rich media element does not match local file type: ${candidate.source}`,
      );
    }
    markdown += candidate.render(telegramRichMediaReference(resolved), resolved.media.type);
  }
  markdown += params.text.slice(cursor);

  const appended: Array<{ source: string; reference: string; figure: string }> = [];
  for (const source of params.mediaUrls ?? []) {
    if (!isTelegramRichLocalMediaSource(source)) {
      continue;
    }
    const resolved = await resolve(source);
    if (!resolved) {
      continue;
    }
    const reference = telegramRichMediaReference(resolved);
    appended.push({ source, reference, figure: buildFigure(reference, resolved.media.type) });
  }
  const withFigures = (figures: typeof appended) =>
    figures.length
      ? `${markdown.trimEnd()}\n\n${figures.map((entry) => entry.figure).join("\n\n")}`
      : markdown;
  const finalSources = appended.length
    ? inputRichBlockMediaSources(
        buildTelegramRichMarkdownPlan(withFigures(appended), {
          tableMode: params.tableMode,
          skipEntityDetection: params.skipEntityDetection,
        }).richMessage.blocks,
      )
    : undefined;
  // An unclosed code fence or HTML container can swallow appended figures.
  // Keep those files on ordinary delivery and remove their internal references.
  const acceptedFigures = appended.filter((entry) => finalSources?.has(entry.reference));
  const consumedSources = new Set(acceptedFigures.map((entry) => entry.source));
  return {
    text: withFigures(acceptedFigures),
    media: finalSources
      ? media.filter((entry) => finalSources.has(telegramRichMediaReference(entry)))
      : media,
    unconsumedMediaUrls: (params.mediaUrls ?? []).filter((source) => !consumedSources.has(source)),
  };
}
