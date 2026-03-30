import { i as resolveWhatsAppAccount } from "./accounts-B5SFFfMD.js";
import "./paths-DVWx7USN.js";
import "./github-copilot-token-Cg0YPPSu.js";
import "./config-DunvA-uZ.js";
import "./subsystem-B0uKDnzH.js";
import "./command-format-BVkj1PMu.js";
import "./agent-scope-DgbjWdYv.js";
import "./message-channel-DRVy6F53.js";
import "./plugins-D_msJzdO.js";
import "./bindings-ZfMMaVYO.js";
import "./path-alias-guards-s-QPXGlx.js";
import "./fs-safe-g5ELf_pw.js";
import "./image-ops-C5t1cRmC.js";
import "./ssrf-D07_rJxG.js";
import "./fetch-guard-Bj06Hz72.js";
import "./local-roots-DbFvAaXE.js";
import "./ir-DSH0voN3.js";
import "./chunk-Do0HitoK.js";
import "./markdown-tables-B31KzXG_.js";
import "./render-Dk3zVolZ.js";
import "./tables-B8rqBdR_.js";
import "./tool-images-ByaQlJ8J.js";
import { a as createActionGate, c as jsonResult, d as readReactionParams, i as ToolAuthorizationError, m as readStringParam } from "./target-errors-C-82w3K4.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-DcJin1BB.js";
import { r as sendReactionWhatsApp } from "./outbound-BvdYxJfp.js";

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