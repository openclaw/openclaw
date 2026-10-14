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

function extractVisibleMentionText(value?: string): string {
  return normalizeLowercaseStringOrEmpty(
    decodeVisibleHtmlEntities(
      (value ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""),
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

function resolveMatrixMentionPrefixCandidates(params: {
  userId?: string | null;
  displayName?: string | null;
}): string[] {
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

  return candidates;
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

  for (const candidate of resolveMatrixMentionPrefixCandidates(params)) {
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

function isVisibleMentionLabel(params: {
  text: string;
  userId: string;
  mentionRegexes: RegExp[];
  displayName?: string | null;
}): boolean {
  const cleaned = extractVisibleMentionText(params.text);
  if (!cleaned) {
    return false;
  }
  if (params.mentionRegexes.some((pattern) => pattern.test(cleaned))) {
    return true;
  }
  const localpart = resolveMatrixUserLocalpart(params.userId);
  const candidates = [
    extractVisibleMentionText(params.userId),
    localpart ? extractVisibleMentionText(localpart) : null,
    localpart ? extractVisibleMentionText(`@${localpart}`) : null,
    params.displayName ? extractVisibleMentionText(params.displayName) : null,
    params.displayName ? extractVisibleMentionText(`@${params.displayName}`) : null,
    params.displayName ? extractVisibleMentionText(`@[${params.displayName}]`) : null,
  ].filter((value): value is string => Boolean(value));
  return candidates.includes(cleaned);
}

function hasVisibleRoomMention(value?: string): boolean {
  const cleaned = extractVisibleMentionText(value);
  return /(^|[^a-z0-9_])@room\b/i.test(cleaned);
}

/**
 * Check if formatted_body contains a matrix.to link whose visible label still
 * looks like a real mention for the given user. Do not trust href alone, since
 * senders can hide arbitrary matrix.to links behind unrelated link text.
 * Many Matrix clients (including Element) use HTML links in formatted_body instead of
 * or in addition to the m.mentions field.
 */
function checkFormattedBodyMention(params: {
  formattedBody?: string;
  userId: string;
  displayName?: string | null;
  mentionRegexes: RegExp[];
}): boolean {
  if (!params.formattedBody || !params.userId) {
    return false;
  }
  const anchorPattern = /<a\b[^>]*href=(["'])(https:\/\/matrix\.to\/#[^"']+)\1[^>]*>(.*?)<\/a>/gis;
  for (const match of params.formattedBody.matchAll(anchorPattern)) {
    const href = match[2];
    const visibleLabel = match[3] ?? "";
    if (!href) {
      continue;
    }
    try {
      const parsed = new URL(href);
      const fragmentTarget = decodeURIComponent(parsed.hash.replace(/^#\/?/, "").trim());
      if (fragmentTarget !== params.userId.trim()) {
        continue;
      }
      if (
        isVisibleMentionLabel({
          text: visibleLabel,
          userId: params.userId,
          mentionRegexes: params.mentionRegexes,
          displayName: params.displayName,
        })
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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

  const mentionedInFormattedBody = params.userId
    ? checkFormattedBodyMention({
        formattedBody: params.content.formatted_body,
        userId: params.userId,
        displayName: params.displayName,
        mentionRegexes: params.mentionRegexes,
      })
    : false;
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
