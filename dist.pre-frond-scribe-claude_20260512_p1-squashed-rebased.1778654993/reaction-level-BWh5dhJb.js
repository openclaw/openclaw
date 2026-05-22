import { t as resolveReactionLevel } from "./reaction-level-B91wiV_G.js";
import "./status-helpers-Dzp0y1UL.js";
import { t as resolveMergedWhatsAppAccountConfig } from "./account-config-B2AN1tpC.js";
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
