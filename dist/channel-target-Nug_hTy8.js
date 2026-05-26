import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString, t as hasNonEmptyString$1 } from "./string-coerce-DyL154ka.js";
import { t as getBootstrapChannelPlugin } from "./bootstrap-registry-W87CNNcz.js";
//#region src/infra/outbound/message-action-param-keys.ts
const STANDARD_MESSAGE_ACTION_PARAM_KEYS = new Set([
	"accountId",
	"asDocument",
	"attachments",
	"base64",
	"bestEffort",
	"caption",
	"channel",
	"channelId",
	"contentType",
	"delivery",
	"dryRun",
	"filePath",
	"fileUrl",
	"filename",
	"forceDocument",
	"gifPlayback",
	"image",
	"interactive",
	"media",
	"mediaUrl",
	"message",
	"mimeType",
	"path",
	"pollAnonymous",
	"pollDurationHours",
	"pollMulti",
	"pollOption",
	"pollPublic",
	"pollQuestion",
	"pin",
	"presentation",
	"replyTo",
	"silent",
	"target",
	"targets",
	"text",
	"threadId",
	"topLevel",
	"to"
]);
function hasPotentialPluginActionParam(params) {
	return Object.entries(params).some(([key, value]) => {
		if (STANDARD_MESSAGE_ACTION_PARAM_KEYS.has(key)) return false;
		if (typeof value === "string") return Boolean(normalizeOptionalString(value));
		if (typeof value === "number") return Number.isFinite(value);
		return value !== void 0;
	});
}
//#endregion
//#region src/infra/outbound/message-action-spec.ts
const MESSAGE_ACTION_TARGET_MODE = {
	send: "to",
	broadcast: "none",
	poll: "to",
	"poll-vote": "to",
	react: "to",
	reactions: "to",
	read: "to",
	edit: "to",
	unsend: "to",
	reply: "to",
	sendWithEffect: "to",
	renameGroup: "to",
	setGroupIcon: "to",
	addParticipant: "to",
	removeParticipant: "to",
	leaveGroup: "to",
	sendAttachment: "to",
	delete: "to",
	pin: "to",
	unpin: "to",
	"list-pins": "to",
	permissions: "to",
	"thread-create": "to",
	"thread-list": "none",
	"thread-reply": "to",
	search: "none",
	sticker: "to",
	"sticker-search": "none",
	"member-info": "none",
	"role-info": "none",
	"emoji-list": "none",
	"emoji-upload": "none",
	"sticker-upload": "none",
	"role-add": "none",
	"role-remove": "none",
	"channel-info": "channelId",
	"channel-list": "none",
	"channel-create": "none",
	"channel-edit": "channelId",
	"channel-delete": "channelId",
	"channel-move": "channelId",
	"category-create": "none",
	"category-edit": "none",
	"category-delete": "none",
	"topic-create": "to",
	"topic-edit": "to",
	"voice-status": "none",
	"event-list": "none",
	"event-create": "none",
	timeout: "none",
	kick: "none",
	ban: "none",
	"set-profile": "none",
	"set-presence": "none",
	"download-file": "none",
	"upload-file": "to"
};
const ACTION_TARGET_ALIASES = {
	unsend: { aliases: ["messageId"] },
	edit: { aliases: ["messageId"] },
	react: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	renameGroup: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	setGroupIcon: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	addParticipant: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	removeParticipant: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] },
	leaveGroup: { aliases: [
		"chatGuid",
		"chatIdentifier",
		"chatId"
	] }
};
function listActionTargetAliasSpecs(action, params, channel) {
	const specs = [];
	const coreSpec = ACTION_TARGET_ALIASES[action];
	if (coreSpec) specs.push(coreSpec);
	const normalizedChannel = normalizeOptionalLowercaseString(channel);
	if (!normalizedChannel || !hasPotentialPluginActionParam(params)) return specs;
	const channelSpec = getBootstrapChannelPlugin(normalizedChannel)?.actions?.messageActionTargetAliases?.[action];
	if (channelSpec) specs.push(channelSpec);
	return specs;
}
function actionRequiresTarget(action) {
	return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}
function actionHasTarget(action, params, options) {
	if (normalizeOptionalString(params.to) ?? "") return true;
	if (normalizeOptionalString(params.channelId) ?? "") return true;
	const specs = listActionTargetAliasSpecs(action, params, options?.channel);
	if (specs.length === 0) return false;
	return specs.some((spec) => spec.aliases.some((alias) => {
		const value = params[alias];
		if (typeof value === "string") return Boolean(normalizeOptionalString(value));
		if (typeof value === "number") return Number.isFinite(value);
		return false;
	}));
}
//#endregion
//#region src/infra/outbound/channel-target.ts
const hasNonEmptyString = hasNonEmptyString$1;
const CHANNEL_TARGET_DESCRIPTION = "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack/Mattermost <channelId|user:ID|channel:ID>, or iMessage handle/chat_id";
const CHANNEL_TARGETS_DESCRIPTION = "Recipient/channel targets (same format as --target); accepts ids or names when the directory is available.";
function applyTargetToParams(params) {
	const target = normalizeOptionalString(params.args.target) ?? "";
	const hasLegacyTo = hasNonEmptyString(params.args.to);
	const hasLegacyChannelId = hasNonEmptyString(params.args.channelId);
	const mode = MESSAGE_ACTION_TARGET_MODE[params.action] ?? "none";
	if (mode !== "none") {
		if (hasLegacyTo || hasLegacyChannelId) throw new Error("Use `target` instead of `to`/`channelId`.");
	} else if (hasLegacyTo) throw new Error("Use `target` for actions that accept a destination.");
	if (!target) return;
	if (mode === "channelId") {
		params.args.channelId = target;
		return;
	}
	if (mode === "to") {
		params.args.to = target;
		return;
	}
	throw new Error(`Action ${params.action} does not accept a target.`);
}
//#endregion
export { actionHasTarget as a, hasNonEmptyString as i, CHANNEL_TARGET_DESCRIPTION as n, actionRequiresTarget as o, applyTargetToParams as r, hasPotentialPluginActionParam as s, CHANNEL_TARGETS_DESCRIPTION as t };
