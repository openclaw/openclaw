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

type MarkdownCodeSegment = {
  end: number;
  start: number;
};

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

function findLineEnd(text: string, start: number): number {
  const lineFeed = text.indexOf("\n", start);
  return lineFeed === -1 ? text.length : lineFeed + 1;
}

function stripLineBreak(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function findClosingFenceEnd(params: {
  markerLength: number;
  start: number;
  text: string;
}): number {
  let lineStart = params.start;
  while (lineStart < params.text.length) {
    const lineEnd = findLineEnd(params.text, lineStart);
    const line = stripLineBreak(params.text.slice(lineStart, lineEnd));
    const closing = /^( {0,3})(`{3,})/.exec(line);
    if (closing?.[2] && closing[2].length >= params.markerLength) {
      return lineStart + closing[1].length + closing[2].length;
    }
    lineStart = lineEnd;
  }
  return params.text.length;
}

function findFencedCodeSegments(text: string): MarkdownCodeSegment[] {
  const segments: MarkdownCodeSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const opening = /`{3,}/.exec(text.slice(cursor));
    if (!opening) {
      break;
    }
    const start = cursor + opening.index;
    const marker = opening[0];
    const lineEnd = findLineEnd(text, start);
    const lineTail = stripLineBreak(text.slice(start + marker.length, lineEnd));
    if (lineEnd === text.length && text[lineEnd - 1] !== "\n") {
      cursor = start + marker.length;
      continue;
    }
    if (lineTail.includes("`")) {
      cursor = lineEnd;
      continue;
    }
    const end = findClosingFenceEnd({
      markerLength: marker.length,
      start: lineEnd,
      text,
    });
    segments.push({ start, end });
    cursor = end;
  }
  return segments;
}

function findContainingSegment(
  segments: readonly MarkdownCodeSegment[],
  index: number,
): MarkdownCodeSegment | undefined {
  return segments.find((segment) => index >= segment.start && index < segment.end);
}

function findInlineCodeSegments(
  text: string,
  fencedSegments: readonly MarkdownCodeSegment[],
): MarkdownCodeSegment[] {
  const segments: MarkdownCodeSegment[] = [];
  let index = 0;
  while (index < text.length) {
    const fenced = findContainingSegment(fencedSegments, index);
    if (fenced) {
      index = fenced.end;
      continue;
    }
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    let runLength = 0;
    while (index < text.length && text[index] === "`") {
      runLength += 1;
      index += 1;
    }
    let cursor = index;
    while (cursor < text.length) {
      const nextFence = findContainingSegment(fencedSegments, cursor);
      if (nextFence) {
        cursor = nextFence.end;
        continue;
      }
      if (text[cursor] !== "`") {
        cursor += 1;
        continue;
      }
      const closeStart = cursor;
      let closeLength = 0;
      while (cursor < text.length && text[cursor] === "`") {
        closeLength += 1;
        cursor += 1;
      }
      if (closeLength === runLength) {
        segments.push({ start, end: cursor });
        break;
      }
      cursor = closeStart + Math.max(1, closeLength);
    }
    index = segments.at(-1)?.start === start ? (segments.at(-1)?.end ?? index) : index;
  }
  return segments;
}

function findMarkdownCodeSegments(text: string): MarkdownCodeSegment[] {
  // Discord mention aliases must ignore code without adding plugin dependencies;
  // keep this scanner scoped to Discord-rendered backtick code segments.
  const fencedSegments = findFencedCodeSegments(text);
  return [...fencedSegments, ...findInlineCodeSegments(text, fencedSegments)].toSorted(
    (a, b) => a.start - b.start || a.end - b.end,
  );
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
  for (const segment of findMarkdownCodeSegments(text)) {
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
