import { t as resolveReactionLevel } from "./reaction-level-DL1a3wdf.js";
import "./status-helpers-Cwggsbh4.js";
import { o as resolveTelegramAccount } from "./accounts-tqlU5AwM.js";
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
