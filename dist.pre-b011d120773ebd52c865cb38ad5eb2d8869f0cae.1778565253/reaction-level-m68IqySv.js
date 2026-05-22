import { t as resolveReactionLevel } from "./reaction-level-CBpPWoDl.js";
import "./status-helpers-CMJ5OzbS.js";
import { t as resolveMergedWhatsAppAccountConfig } from "./account-config-D2k0zwXH.js";
//#region extensions/whatsapp/src/reaction-level.ts
/** Resolve the effective reaction level and its implications for WhatsApp. */
function resolveWhatsAppReactionLevel(params) {
	return resolveReactionLevel({
		value: resolveMergedWhatsAppAccountConfig({
			cfg: params.cfg,
			accountId: params.accountId
		}).reactionLevel,
		defaultLevel: "minimal",
		invalidFallback: "minimal"
	});
}
//#endregion
export { resolveWhatsAppReactionLevel as t };
