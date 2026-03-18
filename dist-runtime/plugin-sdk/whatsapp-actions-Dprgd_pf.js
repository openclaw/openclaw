import "./runtime-CDMAx_h4.js";
import { $u as jsonResult, B as resolveWhatsAppOutboundTarget, Xu as ToolAuthorizationError, Zf as resolveWhatsAppAccount, Zu as createActionGate, nd as readStringParam, pt as sendReactionWhatsApp, td as readReactionParams } from "./setup-wizard-helpers-BPw-E_P4.js";
import "./provider-env-vars-CWXfFyDU.js";
import "./logger-D1gzveLR.js";
import "./tmp-openclaw-dir-DgWJsVV_.js";
import "./subsystem-0lZt3jI5.js";
import "./utils-DknlDzAi.js";
import "./fetch-CysqlwhH.js";
import "./retry-CyJj_oar.js";
import "./paths-BDsrA18Z.js";
import "./signal-FT4PyBH3.js";
import "./config-helpers-BQX8LEv1.js";
import "./fetch-CKhAJuFk.js";
import "./exec-DEBhRlDf.js";
import "./agent-scope-CgozsAuQ.js";
import "./reply-prefix-Dcd4HlHm.js";
import "./logger-CXkOEiRn.js";
import "./fetch-guard-DryYzke6.js";
import "./resolve-route-CPxNiUBg.js";
import "./pairing-token-ukgXF6GK.js";
import "./query-expansion-t4qzEE5Z.js";
import "./redact-DkskT6Xp.js";
import "./channel-plugin-common-Cs4waNSc.js";
import "./secret-file-CCHXecQt.js";
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
