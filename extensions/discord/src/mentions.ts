import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordDirectoryUserId } from "./directory-cache.js";

const MARKDOWN_CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const MENTION_CANDIDATE_PATTERN =
  /(^|[\s([{"'.,;:!?，。！？、：；（）《》「」『』【】])@([\p{L}\p{N}_.-]{2,32}(?:#[0-9]{4})?)/gu;
const CJK_ADJACENT_MENTION_CANDIDATE_PATTERN =
  /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])@([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}_.-]{2,32}(?:#[0-9]{4})?)/gu;
const URL_SCHEME_TOKEN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const URL_TOKEN_LEADING_WRAPPERS_PATTERN = /^[<([{（【《「『]+/u;
const URL_TOKEN_TRAILING_PUNCTUATION_PATTERN = /[)\]}>.,;:!?，。！？、：；）】》」』]+$/u;
const DISCORD_RESERVED_MENTIONS = new Set(["everyone", "here"]);

function normalizeSnowflake(value: string | number | bigint): string | null {
  const text = normalizeOptionalStringifiedId(value) ?? "";
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return text;
}

export function formatMention(params: {
  userId?: string | number | bigint | null;
  roleId?: string | number | bigint | null;
  channelId?: string | number | bigint | null;
}): string {
  const userId = params.userId == null ? null : normalizeSnowflake(params.userId);
  const roleId = params.roleId == null ? null : normalizeSnowflake(params.roleId);
  const channelId = params.channelId == null ? null : normalizeSnowflake(params.channelId);
  const values = [
    userId ? { kind: "user" as const, id: userId } : null,
    roleId ? { kind: "role" as const, id: roleId } : null,
    channelId ? { kind: "channel" as const, id: channelId } : null,
  ].filter((entry): entry is { kind: "user" | "role" | "channel"; id: string } => Boolean(entry));
  if (values.length !== 1) {
    throw new Error("formatMention requires exactly one of userId, roleId, or channelId");
  }
  const target = values[0];
  if (target.kind === "user") {
    return `<@${target.id}>`;
  }
  if (target.kind === "role") {
    return `<@&${target.id}>`;
  }
  return `<#${target.id}>`;
}

function rewritePlainTextMentions(text: string, accountId?: string | null): string {
  if (!text.includes("@")) {
    return text;
  }
  const rewriteCandidate = (match: string, rawHandle: string): string => {
    const handle = normalizeOptionalString(rawHandle) ?? "";
    if (!handle) {
      return match;
    }
    const lookup = normalizeLowercaseStringOrEmpty(handle);
    if (DISCORD_RESERVED_MENTIONS.has(lookup)) {
      return match;
    }
    const userId = resolveDiscordDirectoryUserId({
      accountId,
      handle,
    });
    if (!userId) {
      return match;
    }
    return formatMention({ userId });
  };
  const withDelimitedMentions = text.replace(
    MENTION_CANDIDATE_PATTERN,
    (match, prefix, rawHandle) => {
      const rewritten = rewriteCandidate(match, String(rawHandle ?? ""));
      if (rewritten === match) {
        return match;
      }
      return `${String(prefix ?? "")}${rewritten}`;
    },
  );
  return withDelimitedMentions.replace(
    CJK_ADJACENT_MENTION_CANDIDATE_PATTERN,
    (match, rawHandle, offset, sourceText) => {
      if (isLikelyUrlTokenContext(sourceText, offset)) {
        return match;
      }
      return rewriteCandidate(match, String(rawHandle ?? ""));
    },
  );
}

function isLikelyUrlTokenContext(text: string, atIndex: number): boolean {
  let tokenStart = atIndex;
  while (tokenStart > 0 && !/\s/u.test(text[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }
  let tokenEnd = atIndex;
  while (tokenEnd < text.length && !/\s/u.test(text[tokenEnd] ?? "")) {
    tokenEnd += 1;
  }
  const token = text
    .slice(tokenStart, tokenEnd)
    .replace(URL_TOKEN_LEADING_WRAPPERS_PATTERN, "")
    .replace(URL_TOKEN_TRAILING_PUNCTUATION_PATTERN, "");
  return URL_SCHEME_TOKEN_PATTERN.test(token);
}

export function rewriteDiscordKnownMentions(
  text: string,
  params: { accountId?: string | null },
): string {
  if (!text.includes("@")) {
    return text;
  }
  let rewritten = "";
  let offset = 0;
  MARKDOWN_CODE_SEGMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_CODE_SEGMENT_PATTERN)) {
    const matchIndex = match.index ?? 0;
    rewritten += rewritePlainTextMentions(text.slice(offset, matchIndex), params.accountId);
    rewritten += match[0];
    offset = matchIndex + match[0].length;
  }
  rewritten += rewritePlainTextMentions(text.slice(offset), params.accountId);
  return rewritten;
}
