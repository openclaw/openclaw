import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  MSTeamsAttachmentLike,
  MSTeamsHtmlAttachmentSummary,
  MSTeamsInboundMedia,
} from "./types.js";

type InlineImageReference =
  | {
      kind: "data";
      src: string;
      sourceId?: string;
    }
  | {
      kind: "url";
      url: string;
      contentType?: string;
      fileHint?: string;
      sourceId?: string;
    }
  | { kind: "unavailable"; sourceId?: string };

const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

/**
 * Values of `attr` on each `<tag ...>` in document order, matching the captures of
 * `/<tag[^>]+attr=["']([^"']+)["'][^>]*>/gi`: the last attribute spelling inside the
 * tag wins, and a quoted value may contain `>`. Each `<tag` start is resolved from
 * precomputed next-`>` and next-quote positions in one forward pass.
 */
export function htmlTagAttributeValues(
  html: string,
  tag: "img" | "attachment",
  attr: "src" | "id",
  visit?: (value: string, start: number, end: number) => void,
): string[] {
  const length = html.length;
  const nextGt = new Int32Array(length + 1).fill(length);
  const nextQuote = new Int32Array(length + 1).fill(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = html[index];
    nextGt[index] = char === ">" ? index : nextGt[index + 1]!;
    nextQuote[index] = char === '"' || char === "'" ? index : nextQuote[index + 1]!;
  }
  // An attribute spelling is usable when a non-empty value, a closing quote and a
  // later `>` follow it, whichever tag it ends up inside.
  const candidates: Array<{ start: number; valueStart: number; valueEnd: number; end: number }> =
    [];
  for (const match of html.matchAll(new RegExp(`${attr}=["']`, "gi"))) {
    const valueStart = match.index + match[0].length;
    const valueEnd = nextQuote[valueStart]!;
    if (valueEnd > valueStart && valueEnd < length && nextGt[valueEnd + 1]! < length) {
      candidates.push({ start: match.index, valueStart, valueEnd, end: nextGt[valueEnd + 1]! + 1 });
    }
  }
  const values: string[] = [];
  let resumeAt = 0;
  let pastWindow = 0;
  for (const open of html.matchAll(new RegExp(`<${tag}`, "gi"))) {
    if (open.index < resumeAt) {
      continue;
    }
    // The attribute starts at least one character after the tag name (`[^>]+` is
    // non-empty) and no later than the first `>`, so the window only moves forward.
    const nameEnd = open.index + open[0].length;
    const lastStart = nextGt[nameEnd]!;
    while (pastWindow < candidates.length && candidates[pastWindow]!.start <= lastStart) {
      pastWindow += 1;
    }
    const candidate = candidates[pastWindow - 1];
    if (candidate && candidate.start > nameEnd) {
      const value = html.slice(candidate.valueStart, candidate.valueEnd);
      if (visit) {
        visit(value, open.index, candidate.end);
      } else {
        values.push(value);
      }
      resumeAt = candidate.end;
    }
  }
  return values;
}
const GRAPH_HOSTED_CONTENT_SRC_RE = /\/hostedContents\/([^/?#]+)/i;

// Teams emoji sprites are text; require the CDN host plus an emoji path or alt
// marker so genuine images on the same CDN remain media.
const TEAMS_EMOJI_CDN_HOST = "statics.teams.cdn.office.net";
const TEAMS_EMOJI_ASSET_PATH_RE = /\/emoji([/?#]|$)/i;
const IMG_ALT_ATTR_RE = /\balt=["']([^"']*)["']/i;
const EMOJI_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

function isTeamsEmojiSpriteImage(src: string, imgTag: string): boolean {
  const url = URL.parse(src);
  const host = url?.hostname.toLowerCase() ?? "";
  if (host !== TEAMS_EMOJI_CDN_HOST && !host.endsWith(`.${TEAMS_EMOJI_CDN_HOST}`)) {
    return false;
  }
  return (
    TEAMS_EMOJI_ASSET_PATH_RE.test(url?.pathname ?? "") ||
    EMOJI_PICTOGRAPHIC_RE.test(IMG_ALT_ATTR_RE.exec(imgTag)?.[1] ?? "")
  );
}

// Preserve sprite text before HTML stripping, including HTML-only emoji messages.
export function replaceTeamsEmojiSpriteImagesWithAltText(html: string): string {
  const parts: string[] = [];
  let cursor = 0;
  htmlTagAttributeValues(html, "img", "src", (src, start, end) => {
    const imgTag = html.slice(start, end);
    if (isTeamsEmojiSpriteImage(src.trim(), imgTag)) {
      parts.push(html.slice(cursor, start), IMG_ALT_ATTR_RE.exec(imgTag)?.[1] ?? "");
      cursor = end;
    }
  });
  return parts.join("") + html.slice(cursor);
}

function resolveInlineImageSourceId(src: string): string {
  // Graph fallback names hosted content by item ID, while activity HTML carries its `$value` URL.
  // Normalize both paths to one identity so a recovered image replaces its advertised slot.
  const hostedContentId = GRAPH_HOSTED_CONTENT_SRC_RE.exec(src)?.[1];
  if (!hostedContentId) {
    return src;
  }
  try {
    return decodeURIComponent(hostedContentId);
  } catch {
    return hostedContentId;
  }
}

export function normalizeContentType(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  // RFC 2045 makes the media type case-insensitive, but parameter values may
  // remain case-sensitive, so normalize only the type before the first `;`.
  const parameterIndex = trimmed.indexOf(";");
  if (parameterIndex === -1) {
    return trimmed.toLowerCase();
  }
  return `${trimmed.slice(0, parameterIndex).trim().toLowerCase()}${trimmed.slice(parameterIndex)}`;
}

export function resolveMSTeamsMediaKind(params: {
  contentType?: string;
  fileName?: string;
  fileType?: string;
}): MSTeamsInboundMedia["kind"] {
  const mime = normalizeLowercaseStringOrEmpty(params.contentType);
  const name = normalizeLowercaseStringOrEmpty(params.fileName);
  const fileType = normalizeLowercaseStringOrEmpty(params.fileType);

  const looksLikeImage =
    mime.startsWith("image/") || IMAGE_EXT_RE.test(name) || IMAGE_EXT_RE.test(`x.${fileType}`);

  return looksLikeImage ? "image" : "document";
}

export function isLikelyImageAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";
  const name = typeof att.name === "string" ? att.name : "";
  if (contentType.startsWith("image/")) {
    return true;
  }
  if (IMAGE_EXT_RE.test(name)) {
    return true;
  }

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content)
  ) {
    const fileType = typeof att.content.fileType === "string" ? att.content.fileType : "";
    if (fileType && IMAGE_EXT_RE.test(`x.${fileType}`)) {
      return true;
    }
    const fileName = typeof att.content.fileName === "string" ? att.content.fileName : "";
    if (fileName && IMAGE_EXT_RE.test(fileName)) {
      return true;
    }
  }

  return false;
}

export function isDownloadableAttachment(att: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(att.contentType) ?? "";

  if (
    contentType === "application/vnd.microsoft.teams.file.download.info" &&
    isRecord(att.content) &&
    typeof att.content.downloadUrl === "string"
  ) {
    return true;
  }

  return typeof att.contentUrl === "string" && Boolean(att.contentUrl.trim());
}

export function isAdvertisedFileAttachment(attachment: MSTeamsAttachmentLike): boolean {
  const contentType = normalizeContentType(attachment.contentType) ?? "";
  if (
    contentType.startsWith("text/html") ||
    contentType.startsWith("application/vnd.microsoft.card.") ||
    contentType.startsWith("application/vnd.microsoft.teams.card.")
  ) {
    return false;
  }
  return Boolean(
    isDownloadableAttachment(attachment) ||
    isLikelyImageAttachment(attachment) ||
    attachment.name?.trim() ||
    contentType,
  );
}

export function extractHtmlFromAttachment(att: MSTeamsAttachmentLike): string | undefined {
  if (!normalizeContentType(att.contentType)?.startsWith("text/html")) {
    return undefined;
  }
  if (typeof att.content === "string") {
    return att.content;
  }
  if (!isRecord(att.content)) {
    return undefined;
  }
  return typeof att.content.text === "string"
    ? att.content.text
    : typeof att.content.body === "string"
      ? att.content.body
      : typeof att.content.content === "string"
        ? att.content.content
        : undefined;
}

function fileHintFromUrl(src: string): string | undefined {
  return URL.parse(src)?.pathname.split("/").pop() || undefined;
}

export function extractInlineImageReferences(
  attachments: MSTeamsAttachmentLike[],
): InlineImageReference[] {
  const out: InlineImageReference[] = [];
  const seenReferences = new Set<string>();
  const representedAttachmentIds = new Set(
    attachments.flatMap((attachment) => {
      const id = attachment.id?.trim();
      return id && !extractHtmlFromAttachment(attachment) ? [id] : [];
    }),
  );
  for (const att of attachments) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    for (const value of htmlTagAttributeValues(
      replaceTeamsEmojiSpriteImagesWithAltText(html),
      "img",
      "src",
    )) {
      const src = value.trim();
      if (src) {
        if (src.startsWith("data:")) {
          out.push({ kind: "data", src });
        } else if (!seenReferences.has(src)) {
          seenReferences.add(src);
          if (src.startsWith("cid:")) {
            const sourceId = src.slice("cid:".length) || undefined;
            if (!sourceId || !representedAttachmentIds.has(sourceId)) {
              out.push({ kind: "unavailable", sourceId });
            }
            continue;
          }
          out.push({
            kind: "url",
            url: src,
            fileHint: fileHintFromUrl(src),
            sourceId: resolveInlineImageSourceId(src),
          });
        }
      }
    }
  }
  return out;
}

export function safeHostForUrl(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? normalizeLowercaseStringOrEmpty(parsed.hostname) : "invalid-url";
}

function collectHtmlAttachmentIds(html: string, ids: Set<string>): void {
  for (const value of htmlTagAttributeValues(html, "attachment", "id")) {
    const id = value.trim();
    if (id) {
      ids.add(id);
    }
  }
}

/**
 * Extract every `<attachment id="...">` reference from the HTML attachments in
 * the inbound activity. Returns the complete (non-sliced) list; callers that
 * need a capped diagnostic summary can truncate after calling this helper.
 */
export function extractMSTeamsHtmlAttachmentIds(
  attachments: MSTeamsAttachmentLike[] | undefined,
): string[] {
  const list = attachments ?? [];
  const ids = new Set<string>();
  for (const att of list) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    collectHtmlAttachmentIds(html, ids);
  }
  return Array.from(ids);
}

export function summarizeMSTeamsHtmlAttachments(
  attachments: MSTeamsAttachmentLike[] | undefined,
): MSTeamsHtmlAttachmentSummary | undefined {
  const list = attachments ?? [];
  let htmlAttachments = 0;
  let imgTags = 0;
  let dataImages = 0;
  let cidImages = 0;
  const srcHosts = new Set<string>();
  const attachmentIds = new Set<string>();

  for (const att of list) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    htmlAttachments += 1;
    for (const value of htmlTagAttributeValues(html, "img", "src")) {
      imgTags += 1;
      const src = value.trim();
      if (src) {
        if (src.startsWith("data:")) {
          dataImages += 1;
        } else if (src.startsWith("cid:")) {
          cidImages += 1;
        } else {
          srcHosts.add(safeHostForUrl(src));
        }
      }
    }

    collectHtmlAttachmentIds(html, attachmentIds);
  }

  if (htmlAttachments === 0) {
    return undefined;
  }
  return {
    htmlAttachments,
    imgTags,
    dataImages,
    cidImages,
    srcHosts: Array.from(srcHosts).slice(0, 5),
    attachmentIds: Array.from(attachmentIds).slice(0, 5),
  };
}

export function resolveUnrepresentedHtmlAttachmentIds(
  attachments: MSTeamsAttachmentLike[],
): string[] {
  const representedIds = new Set<string>();
  for (const attachment of attachments) {
    const contentType = normalizeContentType(attachment.contentType) ?? "";
    if (contentType.startsWith("text/html")) {
      continue;
    }
    const id = attachment.id?.trim();
    if (id) {
      representedIds.add(id);
    }
  }
  return extractMSTeamsHtmlAttachmentIds(attachments).filter((id) => !representedIds.has(id));
}

function createAdvertisedMediaFact(
  kind: MSTeamsInboundMedia["kind"],
  sourceId?: string,
): MSTeamsInboundMedia {
  return { kind, ...(sourceId ? { sourceId } : {}) };
}

export function resolveMSTeamsAdvertisedMedia(
  attachments: MSTeamsAttachmentLike[] | undefined,
): MSTeamsInboundMedia[] {
  const list = attachments ?? [];
  const fileAttachments = list.filter(isAdvertisedFileAttachment);
  const inlineMedia = extractInlineImageReferences(list).map((candidate) =>
    createAdvertisedMediaFact("image", candidate.sourceId),
  );
  // Teams HTML uses <attachment> tags as references. A matching attachment
  // entry is the same resource (and may be a card), so count only unmatched
  // IDs that need the Graph/Bot Framework hosted-content fallback.
  const htmlAttachmentIds = resolveUnrepresentedHtmlAttachmentIds(list);
  return [
    ...fileAttachments.map((attachment) =>
      createAdvertisedMediaFact(
        isLikelyImageAttachment(attachment)
          ? "image"
          : resolveMSTeamsMediaKind({
              contentType: normalizeContentType(attachment.contentType),
              fileName: attachment.name ?? undefined,
            }),
        attachment.id?.trim() || undefined,
      ),
    ),
    ...inlineMedia,
    ...htmlAttachmentIds.map((sourceId) => createAdvertisedMediaFact("document", sourceId)),
  ];
}
