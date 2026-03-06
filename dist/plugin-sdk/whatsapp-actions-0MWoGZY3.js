import "./run-with-concurrency-xRatbMJ3.js";
import "./config-CwFG3Aiu.js";
import "./logger-D7wQiObc.js";
import "./paths-0d8fBoC4.js";
import { i as resolveWhatsAppAccount } from "./accounts-B-BIsjh0.js";
import "./plugins-CNQPL_yy.js";
import { f as readStringParam, l as readReactionParams, o as jsonResult, r as createActionGate, t as ToolAuthorizationError } from "./common-BzK-mJAr.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-Blz_BCWu.js";
import "./image-ops-D8eX54vX.js";
import "./github-copilot-token-CKKBybuX.js";
import "./path-alias-guards-DdX97sU3.js";
import "./fs-safe-CslOH3Os.js";
import "./proxy-env-DFv8X456.js";
import "./tool-images-C_WLUyGm.js";
import "./fetch-guard-C8VlFimC.js";
import "./local-roots-CnNufxoc.js";
import "./ir-CwcWVAQY.js";
import "./render-95l30zcf.js";
import "./tables-CvD_yywZ.js";
import { r as sendReactionWhatsApp } from "./outbound-y1_A7O7s.js";

//#region src/agents/tools/whatsapp-target-auth.ts
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
//#region src/agents/tools/whatsapp-actions.ts
async function handleWhatsAppAction(params, cfg) {
	const action = readStringParam(params, "action", { required: true });
	const isActionEnabled = createActionGate(cfg.channels?.whatsapp?.actions);
	if (action === "react") {
		if (!isActionEnabled("reactions")) throw new Error("WhatsApp reactions are disabled.");
		const chatJid = readStringParam(params, "chatJid", { required: true });
		const messageId = readStringParam(params, "messageId", { required: true });
		const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a WhatsApp reaction." });
		const participant = readStringParam(params, "participant");
		const accountId = readStringParam(params, "accountId");
		const fromMeRaw = params.fromMe;
		const fromMe = typeof fromMeRaw === "boolean" ? fromMeRaw : void 0;
		const resolved = resolveAuthorizedWhatsAppOutboundTarget({
			cfg,
			chatJid,
			accountId,
			actionLabel: "reaction"
		});
		const resolvedEmoji = remove ? "" : emoji;
		await sendReactionWhatsApp(resolved.to, messageId, resolvedEmoji, {
			verbose: false,
			fromMe,
			participant: participant ?? void 0,
			accountId: resolved.accountId
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
export { handleWhatsAppAction };