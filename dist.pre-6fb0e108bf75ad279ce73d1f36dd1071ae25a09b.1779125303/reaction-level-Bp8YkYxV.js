import { t as resolveReactionLevel } from "./reaction-level-BDvcYDaV.js";
import "./status-helpers-DYX6v68d.js";
import { o as resolveTelegramAccount } from "./accounts-7hb_ng-4.js";
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
