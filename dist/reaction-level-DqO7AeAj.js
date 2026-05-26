import { t as resolveReactionLevel } from "./reaction-level-Djuz3vHr.js";
import "./status-helpers-CnvYAK73.js";
import { o as resolveTelegramAccount } from "./accounts-CYn64t2S.js";
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
