import { resolveDiscordDirectoryUserId } from "./directory-cache.js";
const MARKDOWN_CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const MENTION_CANDIDATE_PATTERN = /(^|[\s([{"'.,;:!?])@([a-z0-9_.-]{2,32}(?:#[0-9]{4})?)/gi;
const DISCORD_RESERVED_MENTIONS = /* @__PURE__ */ new Set(["everyone", "here"]);
function normalizeSnowflake(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return text;
}
function formatMention(params) {
  const userId = params.userId == null ? null : normalizeSnowflake(params.userId);
  const roleId = params.roleId == null ? null : normalizeSnowflake(params.roleId);
  const channelId = params.channelId == null ? null : normalizeSnowflake(params.channelId);
  const values = [
    userId ? { kind: "user", id: userId } : null,
    roleId ? { kind: "role", id: roleId } : null,
    channelId ? { kind: "channel", id: channelId } : null
  ].filter((entry) => Boolean(entry));
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
function rewritePlainTextMentions(text, accountId) {
  if (!text.includes("@")) {
    return text;
  }
  return text.replace(MENTION_CANDIDATE_PATTERN, (match, prefix, rawHandle) => {
    const handle = String(rawHandle ?? "").trim();
    if (!handle) {
      return match;
    }
    const lookup = handle.toLowerCase();
    if (DISCORD_RESERVED_MENTIONS.has(lookup)) {
      return match;
    }
    const userId = resolveDiscordDirectoryUserId({
      accountId,
      handle
    });
    if (!userId) {
      return match;
    }
    return `${String(prefix ?? "")}${formatMention({ userId })}`;
  });
}
function rewriteDiscordKnownMentions(text, params) {
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
export {
  formatMention,
  rewriteDiscordKnownMentions
};
