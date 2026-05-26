import { c as normalizeInteractiveReply, f as renderMessagePresentationFallbackText, o as interactiveReplyToPresentation, p as resolveInteractiveTextFallback } from "./payload-BGXKFAMn.js";
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
export { resolveTelegramInteractiveTextFallback as t };
