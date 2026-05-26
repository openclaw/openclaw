import { t as resolveReactionLevel } from "./reaction-level-Cbc8nvHn.js";
import "./status-helpers-Dk-3BT6p.js";
import { o as resolveTelegramAccount } from "./accounts-DQtKXSlz.js";
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
