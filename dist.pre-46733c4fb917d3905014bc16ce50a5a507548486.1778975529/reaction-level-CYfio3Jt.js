import { t as resolveReactionLevel } from "./reaction-level-JvWiFPvs.js";
import "./status-helpers-Drvd6qXd.js";
import { o as resolveTelegramAccount } from "./accounts-CRKWxKK3.js";
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
