// Discord plugin module implements mentions behavior.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordDirectoryUserId } from "./directory-cache.js";

type DiscordMentionAliasesConfig = Record<string, string>;

const MENTION_CANDIDATE_PATTERN = /(^|[\s([{"'.,;:!?])@([a-z0-9_.-]{2,32}(?:#[0-9]{4})?)/gi;
const DISCORD_RESERVED_MENTIONS = new Set(["everyone", "here"]);
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;
const DISCORD_TARGETED_MENTION_PATTERN = /<@!?\d+>|<@&\d+>/;
const DISCORD_BROADCAST_MENTION_PATTERN = /@(everyone|here)\b/;
type MarkdownCodeSegment = { start: number; end: number };

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

function normalizeHandleKey(raw: string): string | null {
  let handle = normalizeOptionalString(raw) ?? "";
  if (!handle) {
    return null;
  }
  if (handle.startsWith("@")) {
    handle = normalizeOptionalString(handle.slice(1)) ?? "";
  }
  if (!handle || /\s/.test(handle)) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(handle);
}

function resolveConfiguredMentionAlias(
  handle: string,
  mentionAliases?: DiscordMentionAliasesConfig | null,
): string | undefined {
  const key = normalizeHandleKey(handle);
  if (!key || !mentionAliases) {
    return undefined;
  }
  const withoutDiscriminator = key.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
  for (const [rawAlias, rawUserId] of Object.entries(mentionAliases)) {
    const alias = normalizeHandleKey(rawAlias);
    if (!alias) {
      continue;
    }
    const aliasWithoutDiscriminator = alias.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
    if (
      alias === key ||
      (withoutDiscriminator && withoutDiscriminator !== key && alias === withoutDiscriminator) ||
      (aliasWithoutDiscriminator &&
        aliasWithoutDiscriminator !== alias &&
        aliasWithoutDiscriminator === key)
    ) {
      const userId = normalizeSnowflake(rawUserId);
      if (userId) {
        return userId;
      }
    }
  }
  return undefined;
}

function rewritePlainTextMentions(
  text: string,
  params: {
    accountId?: string | null;
    mentionAliases?: DiscordMentionAliasesConfig | null;
  },
): string {
  if (!text.includes("@")) {
    return text;
  }
  return text.replace(MENTION_CANDIDATE_PATTERN, (match, prefix, rawHandle) => {
    const handle = normalizeOptionalString(rawHandle) ?? "";
    if (!handle) {
      return match;
    }
    const lookup = normalizeLowercaseStringOrEmpty(handle);
    if (DISCORD_RESERVED_MENTIONS.has(lookup)) {
      return match;
    }
    const userId =
      resolveConfiguredMentionAlias(handle, params.mentionAliases) ??
      resolveDiscordDirectoryUserId({
        accountId: params.accountId,
        handle,
      });
    if (!userId) {
      return match;
    }
    return `${String(prefix ?? "")}${formatMention({ userId })}`;
  });
}

function countRun(text: string, index: number, char: "`" | "~"): number {
  let end = index;
  while (end < text.length && text[end] === char) {
    end += 1;
  }
  return end - index;
}

function findLineEnd(text: string, index: number): number {
  const lineEnd = text.indexOf("\n", index);
  return lineEnd === -1 ? text.length : lineEnd;
}

function isFenceLine(params: {
  text: string;
  lineStart: number;
  fenceChar?: "`" | "~";
  minLength: number;
  requireClosingLine: boolean;
}): { fenceChar: "`" | "~"; fenceLength: number; fenceStart: number; fenceEnd: number } | null {
  const { text, lineStart, fenceChar, minLength, requireClosingLine } = params;
  const lineEnd = findLineEnd(text, lineStart);
  let index = lineStart;
  let indent = 0;
  while (index < lineEnd && text[index] === " " && indent < 4) {
    index += 1;
    indent += 1;
  }
  if (indent > 3 || index >= lineEnd) {
    return null;
  }
  const currentFenceChar = text[index];
  if (currentFenceChar !== "`" && currentFenceChar !== "~") {
    return null;
  }
  if (fenceChar != null && currentFenceChar !== fenceChar) {
    return null;
  }
  const fenceLength = countRun(text, index, currentFenceChar);
  if (fenceLength < minLength) {
    return null;
  }
  if (requireClosingLine && text.slice(index + fenceLength, lineEnd).trim() !== "") {
    return null;
  }
  return {
    fenceChar: currentFenceChar,
    fenceLength,
    fenceStart: index,
    fenceEnd: index + fenceLength,
  };
}

function findFencedCodeSegment(text: string, index: number): MarkdownCodeSegment | null {
  const fenceChar = text[index];
  if (fenceChar !== "`" && fenceChar !== "~") {
    return null;
  }
  const fenceLength = countRun(text, index, fenceChar);
  if (fenceLength < 3) {
    return null;
  }
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const openerIsIndentedLine =
    index - lineStart <= 3 && text.slice(lineStart, index).trim() === "";
  const openerLineEnd = findLineEnd(text, index);
  let sameLineCloserCursor = index + fenceLength;
  while (sameLineCloserCursor < openerLineEnd) {
    if (text[sameLineCloserCursor] !== fenceChar) {
      sameLineCloserCursor += 1;
      continue;
    }
    const closingLength = countRun(text, sameLineCloserCursor, fenceChar);
    if (closingLength >= fenceLength) {
      return {
        start: openerIsIndentedLine ? lineStart : index,
        end: sameLineCloserCursor + closingLength,
      };
    }
    sameLineCloserCursor += closingLength;
  }
  let nextLineStart = findLineEnd(text, index);
  if (nextLineStart < text.length) {
    nextLineStart += 1;
  }
  while (nextLineStart < text.length) {
    const closer = isFenceLine({
      text,
      lineStart: nextLineStart,
      fenceChar,
      minLength: fenceLength,
      requireClosingLine: false,
    });
    const lineEnd = findLineEnd(text, nextLineStart);
    if (closer) {
      return {
        start: openerIsIndentedLine ? lineStart : index,
        end: closer.fenceEnd,
      };
    }
    nextLineStart = lineEnd < text.length ? lineEnd + 1 : text.length;
  }
  if (!openerIsIndentedLine) {
    return null;
  }
  return {
    start: lineStart,
    end: text.length,
  };
}

function findInlineCodeSegment(text: string, index: number): MarkdownCodeSegment | null {
  if (text[index] !== "`") {
    return null;
  }
  const fenceLength = countRun(text, index, "`");
  let cursor = index + fenceLength;
  while (cursor < text.length && text[cursor] !== "\n") {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    const closingLength = countRun(text, cursor, "`");
    if (closingLength === fenceLength) {
      return {
        start: index,
        end: cursor + closingLength,
      };
    }
    cursor += closingLength;
  }
  return null;
}

function collectMarkdownCodeSegments(text: string): MarkdownCodeSegment[] {
  const segments: MarkdownCodeSegment[] = [];
  let index = 0;
  while (index < text.length) {
    const fenced = findFencedCodeSegment(text, index);
    if (fenced) {
      segments.push(fenced);
      index = fenced.end;
      continue;
    }
    const inline = findInlineCodeSegment(text, index);
    if (inline) {
      segments.push(inline);
      index = inline.end;
      continue;
    }
    index += 1;
  }
  return segments;
}

export function rewriteDiscordKnownMentions(
  text: string,
  params: {
    accountId?: string | null;
    mentionAliases?: DiscordMentionAliasesConfig | null;
  },
): string {
  if (!text.includes("@")) {
    return text;
  }
  let rewritten = "";
  let offset = 0;
  for (const segment of collectMarkdownCodeSegments(text)) {
    rewritten += rewritePlainTextMentions(text.slice(offset, segment.start), params);
    rewritten += text.slice(segment.start, segment.end);
    offset = segment.end;
  }
  rewritten += rewritePlainTextMentions(text.slice(offset), params);
  return rewritten;
}

/** Whether text carries a Discord user/role mention (`<@id>`, `<@!id>`, `<@&id>`) that pings when sent fresh. */
export function discordTextHasTargetedMention(text: string): boolean {
  return DISCORD_TARGETED_MENTION_PATTERN.test(text);
}

/** Whether text carries an `@everyone`/`@here` broadcast mention. */
export function discordTextHasBroadcastMention(text: string): boolean {
  return DISCORD_BROADCAST_MENTION_PATTERN.test(text);
}
