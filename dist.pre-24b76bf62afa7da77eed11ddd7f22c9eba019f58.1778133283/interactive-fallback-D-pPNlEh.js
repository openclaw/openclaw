import { d as resolveInteractiveTextFallback, o as interactiveReplyToPresentation, s as normalizeInteractiveReply, u as renderMessagePresentationFallbackText } from "./payload-B-LeE4TP.js";
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
