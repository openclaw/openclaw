import { d as resolveInteractiveTextFallback, o as interactiveReplyToPresentation, s as normalizeInteractiveReply, u as renderMessagePresentationFallbackText } from "./payload-P9isgxF4.js";
import { t as resolveReactionLevel } from "./text-runtime-CFBwIeh_.js";
import { o as resolveTelegramAccount } from "./accounts-BCLjToSN.js";
//#region extensions/telegram/src/interactive-fallback.ts
function resolveTelegramInteractiveTextFallback(params) {
	const interactive = normalizeInteractiveReply(params.interactive);
	const text = resolveInteractiveTextFallback({
		text: params.text ?? void 0,
		interactive
	});
	if (text?.trim()) return text;
	if (!interactive) return text;
	const presentation = interactiveReplyToPresentation(interactive);
	if (!presentation) return text;
	const fallback = renderMessagePresentationFallbackText({ presentation });
	return fallback.trim() ? fallback : text;
}
//#endregion
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
export { resolveTelegramInteractiveTextFallback as n, resolveTelegramReactionLevel as t };
