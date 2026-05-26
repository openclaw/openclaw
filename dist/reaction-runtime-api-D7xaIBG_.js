import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { i as resolveSignalAccount } from "./accounts-D8MTjG-n.js";
import { n as signalRpcRequest } from "./client-adapter-iuz7P0pP.js";
import { t as resolveSignalRpcContext } from "./rpc-context-D3EYT07u.js";
//#region extensions/signal/src/send-reactions.ts
function normalizeSignalId(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	return trimmed.replace(/^signal:/i, "").trim();
}
function normalizeSignalUuid(raw) {
	const trimmed = normalizeSignalId(raw);
	if (!trimmed) return "";
	if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("uuid:")) return trimmed.slice(5).trim();
	return trimmed;
}
function resolveTargetAuthorParams(params) {
	const candidates = [
		params.targetAuthor,
		params.targetAuthorUuid,
		params.fallback
	];
	for (const candidate of candidates) {
		const raw = candidate?.trim();
		if (!raw) continue;
		const normalized = normalizeSignalUuid(raw);
		if (normalized) return { targetAuthor: normalized };
	}
	return {};
}
async function sendReactionSignalCore(params) {
	const cfg = requireRuntimeConfig(params.opts.cfg, "Signal reactions");
	const apiMode = cfg.channels?.signal?.apiMode;
	const accountInfo = resolveSignalAccount({
		cfg,
		accountId: params.opts.accountId
	});
	const { baseUrl, account } = resolveSignalRpcContext(params.opts, accountInfo);
	const normalizedRecipient = normalizeSignalUuid(params.recipient);
	const groupId = params.opts.groupId?.trim();
	if (!normalizedRecipient && !groupId) throw new Error(params.errors.missingRecipient);
	if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) throw new Error(params.errors.invalidTargetTimestamp);
	const normalizedEmoji = params.emoji?.trim();
	if (!normalizedEmoji) throw new Error(params.errors.missingEmoji);
	const targetAuthorParams = resolveTargetAuthorParams({
		targetAuthor: params.opts.targetAuthor,
		targetAuthorUuid: params.opts.targetAuthorUuid,
		fallback: normalizedRecipient
	});
	if (groupId && !targetAuthorParams.targetAuthor) throw new Error(params.errors.missingTargetAuthor);
	const requestParams = {
		emoji: normalizedEmoji,
		targetTimestamp: params.targetTimestamp,
		...params.remove ? { remove: true } : {},
		...targetAuthorParams
	};
	if (normalizedRecipient) requestParams.recipients = [normalizedRecipient];
	if (groupId) requestParams.groupIds = [groupId];
	if (account) requestParams.account = account;
	return {
		ok: true,
		timestamp: (await signalRpcRequest("sendReaction", requestParams, {
			baseUrl,
			timeoutMs: params.opts.timeoutMs,
			apiMode
		}))?.timestamp
	};
}
/**
* Send a Signal reaction to a message
* @param recipient - UUID or E.164 phone number of the message author
* @param targetTimestamp - Message ID (timestamp) to react to
* @param emoji - Emoji to react with
* @param opts - Optional account/connection overrides
*/
async function sendReactionSignal(recipient, targetTimestamp, emoji, opts) {
	return await sendReactionSignalCore({
		recipient,
		targetTimestamp,
		emoji,
		remove: false,
		opts,
		errors: {
			missingRecipient: "Recipient or groupId is required for Signal reaction",
			invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction",
			missingEmoji: "Emoji is required for Signal reaction",
			missingTargetAuthor: "targetAuthor is required for group reactions"
		}
	});
}
/**
* Remove a Signal reaction from a message
* @param recipient - UUID or E.164 phone number of the message author
* @param targetTimestamp - Message ID (timestamp) to remove reaction from
* @param emoji - Emoji to remove
* @param opts - Optional account/connection overrides
*/
async function removeReactionSignal(recipient, targetTimestamp, emoji, opts) {
	return await sendReactionSignalCore({
		recipient,
		targetTimestamp,
		emoji,
		remove: true,
		opts,
		errors: {
			missingRecipient: "Recipient or groupId is required for Signal reaction removal",
			invalidTargetTimestamp: "Valid targetTimestamp is required for Signal reaction removal",
			missingEmoji: "Emoji is required for Signal reaction removal",
			missingTargetAuthor: "targetAuthor is required for group reaction removal"
		}
	});
}
//#endregion
export { sendReactionSignal as n, removeReactionSignal as t };
