import { _ as readStringParam, a as createActionGate, l as jsonResult, m as readReactionParams, n as ToolAuthorizationError } from "./common-DqyfaHgZ.js";
import "./channel-actions-DlnlmoXy.js";
import { a as resolveWhatsAppAccount } from "./accounts-DyY9IjH9.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-Be8_P5DY.js";
import { t as resolveWhatsAppReactionLevel } from "./reaction-level-D1wOsvie.js";
import { r as sendReactionWhatsApp } from "./send-R6Jpzn6E.js";
//#region extensions/whatsapp/src/action-runtime-target-auth.ts
function resolveAuthorizedWhatsAppOutboundTarget(params) {
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const resolution = resolveWhatsAppOutboundTarget({
		to: params.chatJid,
		allowFrom: account.allowFrom ?? [],
		mode: "implicit"
	});
	if (!resolution.ok) throw new ToolAuthorizationError(`WhatsApp ${params.actionLabel} blocked: chatJid "${params.chatJid}" is not in the configured allowFrom list for account "${account.accountId}".`);
	return {
		to: resolution.to,
		accountId: account.accountId
	};
}
//#endregion
//#region extensions/whatsapp/src/action-runtime.ts
const whatsAppActionRuntime = {
	resolveAuthorizedWhatsAppOutboundTarget,
	sendReactionWhatsApp
};
async function handleWhatsAppAction(params, cfg) {
	const action = readStringParam(params, "action", { required: true });
	const whatsAppConfig = cfg.channels?.whatsapp;
	const isActionEnabled = createActionGate(whatsAppConfig?.actions);
	if (action === "react") {
		const accountId = readStringParam(params, "accountId");
		if (!whatsAppConfig) throw new Error("WhatsApp reactions are disabled.");
		if (!isActionEnabled("reactions")) throw new Error("WhatsApp reactions are disabled.");
		const reactionLevelInfo = resolveWhatsAppReactionLevel({
			cfg,
			accountId: accountId ?? void 0
		});
		if (!reactionLevelInfo.agentReactionsEnabled) throw new Error(`WhatsApp agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). Set channels.whatsapp.reactionLevel to "minimal" or "extensive" to enable.`);
		const chatJid = readStringParam(params, "chatJid", { required: true });
		const messageId = readStringParam(params, "messageId", { required: true });
		const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a WhatsApp reaction." });
		const participant = readStringParam(params, "participant");
		const fromMeRaw = params.fromMe;
		const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : void 0;
		const resolved = whatsAppActionRuntime.resolveAuthorizedWhatsAppOutboundTarget({
			cfg,
			chatJid,
			accountId,
			actionLabel: "reaction"
		});
		const resolvedEmoji = remove ? "" : emoji;
		await whatsAppActionRuntime.sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
			verbose: false,
			fromMe,
			participant: participant ?? void 0,
			accountId: resolved.accountId,
			cfg
		});
		if (!remove && !isEmpty) return jsonResult({
			ok: true,
			added: emoji
		});
		return jsonResult({
			ok: true,
			removed: true
		});
	}
	throw new Error(`Unsupported WhatsApp action: ${action}`);
}
//#endregion
export { whatsAppActionRuntime as n, handleWhatsAppAction as t };
