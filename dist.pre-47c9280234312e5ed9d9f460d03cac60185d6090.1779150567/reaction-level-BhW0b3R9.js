import { t as resolveReactionLevel } from "./reaction-level-cSwvn5OE.js";
import "./status-helpers-DFnAP_vm.js";
import { o as resolveTelegramAccount } from "./accounts-DTKUynB2.js";
//#region extensions/telegram/src/reaction-level.ts
/**
* Resolve the effective reaction level and its implications.
*/
function resolveTelegramReactionLevel(params) {
	return resolveReactionLevel({
		value: resolveTelegramAccount({
			cfg: params.cfg,
			accountId: params.accountId
		}).config.reactionLevel,
		defaultLevel: "minimal",
		invalidFallback: "ack"
	});
}
//#endregion
export { resolveTelegramReactionLevel as t };
