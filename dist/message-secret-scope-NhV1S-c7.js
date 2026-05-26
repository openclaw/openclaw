import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
//#region src/channels/plugins/message-action-names.ts
const CHANNEL_MESSAGE_ACTION_NAMES = [
	"send",
	"broadcast",
	"poll",
	"poll-vote",
	"react",
	"reactions",
	"read",
	"edit",
	"unsend",
	"reply",
	"sendWithEffect",
	"renameGroup",
	"setGroupIcon",
	"addParticipant",
	"removeParticipant",
	"leaveGroup",
	"sendAttachment",
	"delete",
	"pin",
	"unpin",
	"list-pins",
	"permissions",
	"thread-create",
	"thread-list",
	"thread-reply",
	"search",
	"sticker",
	"sticker-search",
	"member-info",
	"role-info",
	"emoji-list",
	"emoji-upload",
	"sticker-upload",
	"role-add",
	"role-remove",
	"channel-info",
	"channel-list",
	"channel-create",
	"channel-edit",
	"channel-delete",
	"channel-move",
	"category-create",
	"category-edit",
	"category-delete",
	"topic-create",
	"topic-edit",
	"voice-status",
	"event-list",
	"event-create",
	"timeout",
	"kick",
	"ban",
	"set-profile",
	"set-presence",
	"set-profile",
	"download-file",
	"upload-file"
];
//#endregion
//#region src/cli/message-secret-scope.ts
function resolveScopedChannelCandidate(value) {
	if (typeof value !== "string") return;
	const normalized = normalizeMessageChannel(value);
	if (!normalized || !isDeliverableMessageChannel(normalized)) return;
	return normalized;
}
function resolveChannelFromTargetValue(target) {
	const trimmed = normalizeOptionalString(target);
	if (!trimmed) return;
	const separator = trimmed.indexOf(":");
	if (separator <= 0) return;
	return resolveScopedChannelCandidate(trimmed.slice(0, separator));
}
function resolveChannelFromTargets(targets) {
	if (!Array.isArray(targets)) return;
	const seen = /* @__PURE__ */ new Set();
	for (const target of targets) {
		const channel = resolveChannelFromTargetValue(target);
		if (channel) seen.add(channel);
	}
	if (seen.size !== 1) return;
	return [...seen][0];
}
function resolveScopedAccountId(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	return normalizeAccountId(trimmed);
}
function resolveMessageSecretScope(params) {
	const channel = resolveScopedChannelCandidate(params.channel) ?? resolveChannelFromTargetValue(params.target) ?? resolveChannelFromTargets(params.targets) ?? resolveScopedChannelCandidate(params.fallbackChannel);
	const accountId = resolveScopedAccountId(params.accountId) ?? resolveScopedAccountId(params.fallbackAccountId ?? void 0);
	return {
		...channel ? { channel } : {},
		...accountId ? { accountId } : {}
	};
}
//#endregion
export { CHANNEL_MESSAGE_ACTION_NAMES as n, resolveMessageSecretScope as t };
