import { t as resolveReactionLevel } from "./reaction-level-B91wiV_G.js";
import "./status-helpers-Dzp0y1UL.js";
import { o as resolveTelegramAccount } from "./accounts-CN_xs_FX.js";
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
