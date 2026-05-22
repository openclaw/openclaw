import { t as resolveReactionLevel } from "./reaction-level-CaWuXa8r.js";
import "./status-helpers-DC20QesH.js";
import { o as resolveTelegramAccount } from "./accounts-BHe98vbE.js";
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
