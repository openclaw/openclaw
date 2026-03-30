import {
  ATTACHMENT_TAG_RE,
  extractHtmlFromAttachment,
  extractInlineImageCandidates,
  IMG_SRC_RE,
  isLikelyImageAttachment,
  safeHostForUrl,
} from "./shared.js";
import type { MSTeamsAttachmentLike, MSTeamsHtmlAttachmentSummary } from "./types.js";

export function summarizeMSTeamsHtmlAttachments(
  attachments: MSTeamsAttachmentLike[] | undefined,
): MSTeamsHtmlAttachmentSummary | undefined {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    return undefined;
  }
  let htmlAttachments = 0;
  let imgTags = 0;
  let dataImages = 0;
  let cidImages = 0;
  const srcHosts = new Set<string>();
  let attachmentTags = 0;
  const attachmentIds = new Set<string>();

  for (const att of list) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      continue;
    }
    htmlAttachments += 1;
    IMG_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = IMG_SRC_RE.exec(html);
    while (match) {
      imgTags += 1;
      const src = match[1]?.trim();
      if (src) {
        if (src.startsWith("data:")) {
          dataImages += 1;
        } else if (src.startsWith("cid:")) {
          cidImages += 1;
        } else {
          srcHosts.add(safeHostForUrl(src));
        }
      }
      match = IMG_SRC_RE.exec(html);
    }

    ATTACHMENT_TAG_RE.lastIndex = 0;
    let attachmentMatch: RegExpExecArray | null = ATTACHMENT_TAG_RE.exec(html);
    while (attachmentMatch) {
      attachmentTags += 1;
      const id = attachmentMatch[1]?.trim();
      if (id) {
        attachmentIds.add(id);
      }
      attachmentMatch = ATTACHMENT_TAG_RE.exec(html);
    }
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
    attachmentTags,
    attachmentIds: Array.from(attachmentIds).slice(0, 5),
  };
}

/**
 * Teams emoji CDN hostname. Teams wraps emoji characters as `<img>` tags with
 * `alt="emoji_character"` and `src` pointing to this CDN. These should be
 * passed through as their unicode text, not treated as image attachments.
 */
const TEAMS_EMOJI_CDN_HOST = "statics.teams.cdn.office.net";

/**
 * Check if an image URL is from the Teams emoji CDN using proper URL host
 * parsing (via safeHostForUrl) to avoid false positives from query strings,
 * redirects, or tracking parameters that happen to contain the CDN hostname.
 */
function isTeamsEmojiCdnUrl(src: string): boolean {
  const host = safeHostForUrl(src);
  return host === TEAMS_EMOJI_CDN_HOST;
}

/**
 * Single-pass regex to extract both src and alt from an <img> tag atomically.
 * Captures: group 1 = everything inside the <img ...> tag.
 * We then extract src and alt from the captured attributes string.
 */
const IMG_TAG_RE = /<img\s+([^>]*)>/gi;
const SRC_ATTR_RE = /\bsrc=["']([^"']+)["']/i;
const ALT_ATTR_RE = /\balt=["']([^"']+)["']/i;

/**
 * Extract emoji unicode characters from Teams HTML attachments that contain
 * only emoji CDN image references. Returns the emoji text if all img tags
 * in the attachment are from the Teams emoji CDN, or null otherwise.
 *
 * Bails out immediately if any non-HTML attachment exists in the list (e.g.
 * a real image/jpeg file), since that means this is not a pure-emoji message.
 *
 * Uses a single-pass regex to evaluate each <img> tag's src and alt atomically,
 * preventing divergence between separate src/alt loops.
 */
export function extractTeamsEmojiText(
  attachments: MSTeamsAttachmentLike[] | undefined,
): string | null {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return null;

  const emojiChars: string[] = [];

  for (const att of list) {
    const html = extractHtmlFromAttachment(att);
    if (!html) {
      // A non-HTML attachment (e.g. a real image file) means this is not
      // a pure-emoji message — fall through to normal placeholder logic.
      return null;
    }

    IMG_TAG_RE.lastIndex = 0;
    let tagMatch: RegExpExecArray | null = IMG_TAG_RE.exec(html);
    while (tagMatch) {
      const attrs = tagMatch[1] ?? "";
      const srcMatch = SRC_ATTR_RE.exec(attrs);
      const altMatch = ALT_ATTR_RE.exec(attrs);
      const src = srcMatch?.[1]?.trim();

      // Every <img> must have a src pointing to the emoji CDN
      if (!src || !isTeamsEmojiCdnUrl(src)) {
        return null;
      }

      // Extract alt text (the emoji unicode character)
      const alt = altMatch?.[1]?.trim();
      if (alt) {
        emojiChars.push(alt);
      }

      tagMatch = IMG_TAG_RE.exec(html);
    }
  }

  return emojiChars.length > 0 ? emojiChars.join("") : null;
}

export function buildMSTeamsAttachmentPlaceholder(
  attachments: MSTeamsAttachmentLike[] | undefined,
): string {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    return "";
  }

  // Check if these are just Teams emoji — return unicode text instead of <media:image>
  const emojiText = extractTeamsEmojiText(list);
  if (emojiText) {
    return emojiText;
  }

  const imageCount = list.filter(isLikelyImageAttachment).length;
  const inlineCount = extractInlineImageCandidates(list).length;
  const totalImages = imageCount + inlineCount;
  if (totalImages > 0) {
    return `<media:image>${totalImages > 1 ? ` (${totalImages} images)` : ""}`;
  }
  const count = list.length;
  return `<media:document>${count > 1 ? ` (${count} files)` : ""}`;
}
