import { t as resolveReactionLevel } from "./reaction-level-B8xcI8Nl.js";
import "./status-helpers-DoFEa01y.js";
import { o as resolveTelegramAccount } from "./accounts-AUFthtWP.js";
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
