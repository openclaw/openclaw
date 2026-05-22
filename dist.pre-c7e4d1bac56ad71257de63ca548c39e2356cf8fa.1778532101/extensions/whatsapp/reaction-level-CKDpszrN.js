import { t as resolveReactionLevel } from "../../text-runtime-FOsx_CPC.js";
import { t as resolveMergedWhatsAppAccountConfig } from "./account-config-B3-90r2p.js";
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
