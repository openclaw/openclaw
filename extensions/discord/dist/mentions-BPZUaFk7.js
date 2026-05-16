import { n as resolveDiscordDirectoryUserId } from "./directory-cache-D93eSrpB.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/text-runtime";
//#region extensions/discord/src/mentions.ts
const MARKDOWN_CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const MENTION_CANDIDATE_PATTERN = /(^|[\s([{"'.,;:!?])@([a-z0-9_.-]{2,32}(?:#[0-9]{4})?)/gi;
const DISCORD_RESERVED_MENTIONS = new Set(["everyone", "here"]);
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;
function normalizeSnowflake(value) {
	const text = normalizeOptionalStringifiedId(value) ?? "";
	if (!/^\d+$/.test(text)) return null;
	return text;
}
function formatMention(params) {
	const userId = params.userId == null ? null : normalizeSnowflake(params.userId);
	const roleId = params.roleId == null ? null : normalizeSnowflake(params.roleId);
	const channelId = params.channelId == null ? null : normalizeSnowflake(params.channelId);
	const values = [
		userId ? {
			kind: "user",
			id: userId
		} : null,
		roleId ? {
			kind: "role",
			id: roleId
		} : null,
		channelId ? {
			kind: "channel",
			id: channelId
		} : null
	].filter((entry) => Boolean(entry));
	if (values.length !== 1) throw new Error("formatMention requires exactly one of userId, roleId, or channelId");
	const target = values[0];
	if (target.kind === "user") return `<@${target.id}>`;
	if (target.kind === "role") return `<@&${target.id}>`;
	return `<#${target.id}>`;
}
function normalizeHandleKey(raw) {
	let handle = normalizeOptionalString(raw) ?? "";
	if (!handle) return null;
	if (handle.startsWith("@")) handle = normalizeOptionalString(handle.slice(1)) ?? "";
	if (!handle || /\s/.test(handle)) return null;
	return normalizeLowercaseStringOrEmpty(handle);
}
function resolveConfiguredMentionAlias(handle, mentionAliases) {
	const key = normalizeHandleKey(handle);
	if (!key || !mentionAliases) return;
	const withoutDiscriminator = key.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
	for (const [rawAlias, rawUserId] of Object.entries(mentionAliases)) {
		const alias = normalizeHandleKey(rawAlias);
		if (!alias) continue;
		const aliasWithoutDiscriminator = alias.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
		if (alias === key || withoutDiscriminator && withoutDiscriminator !== key && alias === withoutDiscriminator || aliasWithoutDiscriminator && aliasWithoutDiscriminator !== alias && aliasWithoutDiscriminator === key) {
			const userId = normalizeSnowflake(rawUserId);
			if (userId) return userId;
		}
	}
}
function rewritePlainTextMentions(text, params) {
	if (!text.includes("@")) return text;
	return text.replace(MENTION_CANDIDATE_PATTERN, (match, prefix, rawHandle) => {
		const handle = normalizeOptionalString(rawHandle) ?? "";
		if (!handle) return match;
		const lookup = normalizeLowercaseStringOrEmpty(handle);
		if (DISCORD_RESERVED_MENTIONS.has(lookup)) return match;
		const userId = resolveConfiguredMentionAlias(handle, params.mentionAliases) ?? resolveDiscordDirectoryUserId({
			accountId: params.accountId,
			handle
		});
		if (!userId) return match;
		return `${String(prefix ?? "")}${formatMention({ userId })}`;
	});
}
function rewriteDiscordKnownMentions(text, params) {
	if (!text.includes("@")) return text;
	let rewritten = "";
	let offset = 0;
	MARKDOWN_CODE_SEGMENT_PATTERN.lastIndex = 0;
	for (const match of text.matchAll(MARKDOWN_CODE_SEGMENT_PATTERN)) {
		const matchIndex = match.index ?? 0;
		rewritten += rewritePlainTextMentions(text.slice(offset, matchIndex), params);
		rewritten += match[0];
		offset = matchIndex + match[0].length;
	}
	rewritten += rewritePlainTextMentions(text.slice(offset), params);
	return rewritten;
}
//#endregion
export { rewriteDiscordKnownMentions as n, formatMention as t };
