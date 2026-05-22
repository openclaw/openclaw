import { t as resolveReactionLevel } from "./reaction-level-B-D7E2LB.js";
import "./status-helpers-tKw3qSeZ.js";
import { o as resolveTelegramAccount } from "./accounts-CcSX-LRn.js";
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
