import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as jsonResult, g as readStringParam, i as createActionGate } from "./common-E9YpX7pB.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as resolveReactionLevel } from "./reaction-level-Djuz3vHr.js";
import "./status-helpers-CnvYAK73.js";
import { r as resolveReactionMessageId } from "./channel-actions-DMN7G5RZ.js";
import { i as resolveSignalAccount, t as listEnabledSignalAccounts } from "./accounts-D8MTjG-n.js";
import { n as sendReactionSignal, t as removeReactionSignal } from "./reaction-runtime-api-D7xaIBG_.js";
//#region extensions/signal/src/reaction-level.ts
/**
* Resolve the effective reaction level and its implications for Signal.
*
* Levels:
* - "off": No reactions at all
* - "ack": Only automatic ack reactions (👀 when processing), no agent reactions
* - "minimal": Agent can react, but sparingly (default)
* - "extensive": Agent can react liberally
*/
function resolveSignalReactionLevel(params) {
	return resolveReactionLevel({
		value: resolveSignalAccount({
			cfg: params.cfg,
			accountId: params.accountId
		}).config.reactionLevel,
		defaultLevel: "minimal",
		invalidFallback: "minimal"
	});
}
//#endregion
//#region extensions/signal/src/message-actions.ts
const providerId = "signal";
const GROUP_PREFIX = "group:";
function normalizeSignalReactionRecipient(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;
	const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
	if (!withoutSignal) return withoutSignal;
	if (normalizeLowercaseStringOrEmpty(withoutSignal).startsWith("uuid:")) return withoutSignal.slice(5).trim();
	return withoutSignal;
}
function resolveSignalReactionTarget(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
	if (!withoutSignal) return {};
	if (normalizeLowercaseStringOrEmpty(withoutSignal).startsWith(GROUP_PREFIX)) {
		const groupId = withoutSignal.slice(6).trim();
		return groupId ? { groupId } : {};
	}
	return { recipient: normalizeSignalReactionRecipient(withoutSignal) };
}
async function mutateSignalReaction(params) {
	const options = {
		cfg: params.cfg,
		accountId: params.accountId,
		groupId: params.target.groupId,
		targetAuthor: params.targetAuthor,
		targetAuthorUuid: params.targetAuthorUuid
	};
	if (params.remove) {
		await removeReactionSignal(params.target.recipient ?? "", params.timestamp, params.emoji, options);
		return jsonResult({
			ok: true,
			removed: params.emoji
		});
	}
	await sendReactionSignal(params.target.recipient ?? "", params.timestamp, params.emoji, options);
	return jsonResult({
		ok: true,
		added: params.emoji
	});
}
const signalMessageActions = {
	describeMessageTool: ({ cfg, accountId }) => {
		const configuredAccounts = accountId ? [resolveSignalAccount({
			cfg,
			accountId
		})].filter((account) => account.enabled && account.configured) : listEnabledSignalAccounts(cfg).filter((account) => account.configured);
		if (configuredAccounts.length === 0) return null;
		const actions = new Set(["send"]);
		if (configuredAccounts.some((account) => createActionGate(account.config.actions)("reactions"))) actions.add("react");
		return { actions: Array.from(actions) };
	},
	supportsAction: ({ action }) => action !== "send",
	handleAction: async ({ action, params, cfg, accountId, toolContext }) => {
		if (action === "send") throw new Error("Send should be handled by outbound, not actions handler.");
		if (action === "react") {
			const reactionLevelInfo = resolveSignalReactionLevel({
				cfg,
				accountId: accountId ?? void 0
			});
			if (!reactionLevelInfo.agentReactionsEnabled) throw new Error(`Signal agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). Set channels.signal.reactionLevel to "minimal" or "extensive" to enable.`);
			const actionConfig = resolveSignalAccount({
				cfg,
				accountId
			}).config.actions;
			if (!createActionGate(actionConfig)("reactions")) throw new Error("Signal reactions are disabled via actions.reactions.");
			const target = resolveSignalReactionTarget(readStringParam(params, "recipient") ?? readStringParam(params, "to", {
				required: true,
				label: "recipient (UUID, phone number, or group)"
			}));
			if (!target.recipient && !target.groupId) throw new Error("recipient or group required");
			const messageIdRaw = resolveReactionMessageId({
				args: params,
				toolContext
			});
			const messageId = messageIdRaw != null ? String(messageIdRaw) : void 0;
			if (!messageId) throw new Error("messageId (timestamp) required. Provide messageId explicitly or react to the current inbound message.");
			const targetAuthor = readStringParam(params, "targetAuthor");
			const targetAuthorUuid = readStringParam(params, "targetAuthorUuid");
			if (target.groupId && !targetAuthor && !targetAuthorUuid) throw new Error("targetAuthor or targetAuthorUuid required for group reactions.");
			const emoji = readStringParam(params, "emoji", { allowEmpty: true });
			const remove = typeof params.remove === "boolean" ? params.remove : void 0;
			const timestamp = Number.parseInt(messageId, 10);
			if (!Number.isFinite(timestamp)) throw new Error(`Invalid messageId: ${messageId}. Expected numeric timestamp.`);
			if (remove) {
				if (!emoji) throw new Error("Emoji required to remove reaction.");
				return await mutateSignalReaction({
					cfg,
					accountId: accountId ?? void 0,
					target,
					timestamp,
					emoji,
					remove: true,
					targetAuthor,
					targetAuthorUuid
				});
			}
			if (!emoji) throw new Error("Emoji required to add reaction.");
			return await mutateSignalReaction({
				cfg,
				accountId: accountId ?? void 0,
				target,
				timestamp,
				emoji,
				remove: false,
				targetAuthor,
				targetAuthorUuid
			});
		}
		throw new Error(`Action ${action} not supported for ${providerId}.`);
	}
};
//#endregion
export { resolveSignalReactionLevel as n, signalMessageActions as t };
