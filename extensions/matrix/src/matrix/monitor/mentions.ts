import { decodeHtmlEntities } from "openclaw/plugin-sdk/html-entity-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { RoomMessageEventContent } from "./types.js";

const MATRIX_HTML_ENTITY_RE = /&(?:#x?[0-9a-f]+|amp|apos|gt|lt|nbsp|quot);/gi;

function decodeVisibleHtmlEntities(value: string): string {
  return value.replace(MATRIX_HTML_ENTITY_RE, (entity) => {
    const decoded = decodeHtmlEntities(entity.startsWith("&#") ? entity : entity.toLowerCase());
    return decoded === "\u00a0" ? " " : decoded;
  });
}

/**
 * Replaces each `<[^>]+>` with a space. No tag can end after the last `>`, so the
 * regex only runs on that prefix and an unterminated `<` run stays linear.
 */
function stripHtmlTags(value: string): string {
  const end = value.lastIndexOf(">") + 1;
  return value.slice(0, end).replace(/<[^>]+>/g, " ") + value.slice(end);
}

/**
 * `href` and label of each anchor, matching the captures of
 * `/<a\b[^>]*href=(["'])(https:\/\/matrix\.to\/#[^"']+)\1[^>]*>(.*?)<\/a>/gis`: the last
 * usable `href=` inside the opening tag wins, the quoted value may contain `>`, and the
 * label ends at the first `</a>`. Each `<a` start is resolved from precomputed next-`>`,
 * next-quote and next-`</a>` positions plus a forward-only candidate cursor, so the scan
 * is linear in the length of sender-controlled HTML.
 */
function* matrixToAnchors(html: string): Generator<{ href: string; label: string }> {
  const length = html.length;
  const nextGt = new Int32Array(length + 1).fill(length);
  const nextQuote = new Int32Array(length + 1).fill(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    const char = html[index];
    nextGt[index] = char === ">" ? index : nextGt[index + 1]!;
    nextQuote[index] = char === '"' || char === "'" ? index : nextQuote[index + 1]!;
  }
  const closes = Array.from(html.matchAll(/<\/a>/gi), (match) => match.index);
  let nextClose = 0;
  // A usable href needs a non-empty value, its own closing quote, a later `>` and a
  // `</a>` after that `>`, whichever `<a` it ends up inside.
  const candidates: Array<{ start: number; href: string; labelStart: number; labelEnd: number }> =
    [];
  for (const match of html.matchAll(/href=(["'])https:\/\/matrix\.to\/#/gi)) {
    const valueStart = match.index + "href=".length + 1;
    const restStart = match.index + match[0].length;
    const valueEnd = nextQuote[restStart]!;
    if (valueEnd === restStart || valueEnd === length || html[valueEnd] !== match[1]) {
      continue;
    }
    const tagEnd = nextGt[valueEnd + 1]!;
    if (tagEnd === length) {
      continue;
    }
    while (nextClose < closes.length && closes[nextClose]! <= tagEnd) {
      nextClose += 1;
    }
    if (nextClose === closes.length) {
      // Later candidates end their tags no earlier, so none of them can close either.
      break;
    }
    candidates.push({
      start: match.index,
      href: html.slice(valueStart, valueEnd),
      labelStart: tagEnd + 1,
      labelEnd: closes[nextClose]!,
    });
  }
  let resumeAt = 0;
  // Count of candidates starting at or before the current tag's last usable index. That
  // index never decreases from one `<a` to the next, so the cursor only moves forward.
  let candidatesBefore = 0;
  for (const open of html.matchAll(/<a\b/gi)) {
    if (open.index < resumeAt) {
      continue;
    }
    // `[^>]*` before `href=`: any characters except `>`.
    const firstStart = open.index + open[0].length;
    const lastStart = nextGt[firstStart]! - 1;
    while (
      candidatesBefore < candidates.length &&
      candidates[candidatesBefore]!.start <= lastStart
    ) {
      candidatesBefore += 1;
    }
    const candidate = candidates[candidatesBefore - 1];
    if (candidate && candidate.start >= firstStart) {
      yield {
        href: candidate.href,
        label: html.slice(candidate.labelStart, candidate.labelEnd),
      };
      resumeAt = candidate.labelEnd + "</a>".length;
    }
  }
}

function extractVisibleMentionText(value?: string): string {
  return normalizeLowercaseStringOrEmpty(
    decodeVisibleHtmlEntities(
      stripHtmlTags(value ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""),
    ).replace(/\s+/g, " "),
  );
}

function resolveMatrixUserLocalpart(userId: string): string | null {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    return null;
  }
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 1) {
    return null;
  }
  return trimmed.slice(1, colonIndex).trim() || null;
}

function hasVisibleNativeMatrixUserMention(text: string | undefined, userId: string): boolean {
  const localpart = resolveMatrixUserLocalpart(userId);
  if (!text || !localpart) {
    return false;
  }

  // Historical localparts can end in any punctuation, so shorthand must stay
  // bare; colon plus visible whitespace is safe because localparts forbid colon.
  const pattern = new RegExp(
    String.raw`(?:^|\p{White_Space})(?:${escapeRegExp(userId)}(?=$|\p{White_Space}|:\p{White_Space}|[,!?;](?=$|\p{White_Space}))|${escapeRegExp(`@${localpart}`)}(?=$|\p{White_Space}|:\p{White_Space}))`,
    "u",
  );
  return pattern.test(text);
}

function stripMatchedMatrixMentionPrefix(
  text: string,
  source: string,
  flags: string,
): string | null {
  const match = text.match(new RegExp(`^\\s*${source}(?:\\s*[:,])?(?:\\s+|$)`, flags));
  return match ? text.slice(match[0].length).trimStart() : null;
}

export function stripMatrixMentionPrefix(params: {
  text: string;
  userId?: string | null;
  displayName?: string | null;
  mentionRegexes?: RegExp[];
}): string {
  const text = params.text;
  if (!text) {
    return text;
  }

  const candidates: string[] = [];
  const seen = new Set<string>();

  const localpart = params.userId ? resolveMatrixUserLocalpart(params.userId) : null;
  for (const candidate of [
    params.userId,
    localpart ? `@${localpart}` : null,
    params.displayName,
    params.displayName ? `@${params.displayName}` : null,
    params.displayName ? `@[${params.displayName}]` : null,
  ]) {
    const trimmed = candidate?.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = normalizeLowercaseStringOrEmpty(trimmed);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push(trimmed);
  }

  for (const candidate of candidates) {
    const stripped = stripMatchedMatrixMentionPrefix(text, escapeRegExp(candidate), "i");
    if (stripped !== null) {
      return stripped;
    }
  }
  for (const pattern of params.mentionRegexes ?? []) {
    const stripped = stripMatchedMatrixMentionPrefix(
      text,
      `(?:${pattern.source})`,
      pattern.flags.replace(/[gy]/g, ""),
    );
    if (stripped !== null) {
      return stripped;
    }
  }
  return text;
}

function hasVisibleRoomMention(value?: string): boolean {
  const cleaned = extractVisibleMentionText(value);
  return /(^|[^a-z0-9_])@room\b/i.test(cleaned);
}

export function resolveMentions(params: {
  content: RoomMessageEventContent;
  userId?: string | null;
  displayName?: string | null;
  text?: string;
  mentionRegexes: RegExp[];
}) {
  const mentions = params.content["m.mentions"];
  const mentionedUsers = Array.isArray(mentions?.user_ids)
    ? new Set(mentions.user_ids)
    : new Set<string>();
  const textMentioned = getMatrixRuntime().channel.mentions.matchesMentionPatterns(
    params.text ?? "",
    params.mentionRegexes,
  );
  const visibleRoomMention =
    hasVisibleRoomMention(params.text) || hasVisibleRoomMention(params.content.formatted_body);

  /**
   * Check if formatted_body contains a matrix.to link whose visible label still
   * looks like a real mention for the given user. Do not trust href alone, since
   * senders can hide arbitrary matrix.to links behind unrelated link text.
   * Many Matrix clients (including Element) use HTML links in formatted_body instead of
   * or in addition to the m.mentions field.
   */
  function checkFormattedBodyMention(userId: string): boolean {
    const formattedBody = params.content.formatted_body;
    const { displayName, mentionRegexes } = params;
    if (!formattedBody || !userId) {
      return false;
    }
    for (const { href, label: visibleLabel } of matrixToAnchors(formattedBody)) {
      try {
        const parsed = new URL(href);
        const fragmentTarget = decodeURIComponent(parsed.hash.replace(/^#\/?/, "").trim());
        if (fragmentTarget !== userId.trim()) {
          continue;
        }
        const cleaned = extractVisibleMentionText(visibleLabel);
        if (!cleaned) {
          continue;
        }
        if (mentionRegexes.some((pattern) => pattern.test(cleaned))) {
          return true;
        }
        const localpart = resolveMatrixUserLocalpart(userId);
        const candidates = [
          extractVisibleMentionText(userId),
          localpart ? extractVisibleMentionText(localpart) : null,
          localpart ? extractVisibleMentionText(`@${localpart}`) : null,
          displayName ? extractVisibleMentionText(displayName) : null,
          displayName ? extractVisibleMentionText(`@${displayName}`) : null,
          displayName ? extractVisibleMentionText(`@[${displayName}]`) : null,
        ].filter((value): value is string => Boolean(value));
        if (candidates.includes(cleaned)) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  const mentionedInFormattedBody = params.userId ? checkFormattedBodyMention(params.userId) : false;
  // Native mentions may use visible plain-text Matrix IDs without HTML. Keep
  // exact metadata ownership and visibility so forged mentions stay inert.
  const metadataBackedUserMention = Boolean(
    params.userId &&
    mentionedUsers.has(params.userId) &&
    (mentionedInFormattedBody ||
      textMentioned ||
      hasVisibleNativeMatrixUserMention(params.text, params.userId)),
  );
  const metadataBackedRoomMention = Boolean(mentions?.room) && visibleRoomMention;
  const explicitMention =
    mentionedInFormattedBody || metadataBackedUserMention || metadataBackedRoomMention;

  const wasMentioned = explicitMention || textMentioned || visibleRoomMention;
  return { wasMentioned, hasExplicitMention: explicitMention };
}
