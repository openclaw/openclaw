import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
//#region extensions/discord/src/session-key-normalization.ts
function normalizeDiscordChatType(raw) {
	const normalized = normalizeLowercaseStringOrEmpty(raw);
	if (!normalized) return;
	if (normalized === "dm") return "direct";
	if (normalized === "group" || normalized === "channel" || normalized === "direct") return normalized;
}
function normalizeExplicitDiscordSessionKey(sessionKey, ctx) {
	let normalized = normalizeLowercaseStringOrEmpty(sessionKey);
	if (normalizeDiscordChatType(ctx.ChatType) !== "direct") return normalized;
	normalized = normalized.replace(/^(discord:)dm:/, "$1direct:");
	normalized = normalized.replace(/^(agent:[^:]+:discord:)dm:/, "$1direct:");
	const match = normalized.match(/^((?:agent:[^:]+:)?)discord:channel:([^:]+)$/);
	if (!match) return normalized;
	const from = normalizeLowercaseStringOrEmpty(ctx.From);
	const senderId = normalizeLowercaseStringOrEmpty(ctx.SenderId);
	const fromDiscordId = from.startsWith("discord:") && !from.includes(":channel:") && !from.includes(":group:") ? from.slice(8) : "";
	const directId = senderId || fromDiscordId;
	return directId && directId === match[2] ? `${match[1]}discord:direct:${match[2]}` : normalized;
}
//#endregion
export { normalizeExplicitDiscordSessionKey as t };
