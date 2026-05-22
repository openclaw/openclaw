import { d as resolveInteractiveTextFallback, o as interactiveReplyToPresentation, s as normalizeInteractiveReply, u as renderMessagePresentationFallbackText } from "./payload-CGJQITh6.js";
import { t as resolveReactionLevel } from "./text-runtime-icMZVCaq.js";
import { o as resolveTelegramAccount } from "./accounts-BPEC79pF.js";
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
