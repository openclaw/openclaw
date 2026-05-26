import { c as normalizeInteractiveReply, f as renderMessagePresentationFallbackText, l as normalizeMessagePresentation, o as interactiveReplyToPresentation, p as resolveInteractiveTextFallback } from "./payload-BDV15CYA.js";
//#region extensions/telegram/src/interactive-fallback.ts
function resolveTelegramInteractiveTextFallback(params) {
	const interactive = normalizeInteractiveReply(params.interactive);
	const text = resolveInteractiveTextFallback({
		text: params.text ?? void 0,
		interactive
	});
	if (text?.trim()) return text;
	const presentation = normalizeMessagePresentation(params.presentation);
	if (presentation) {
		const fallback = renderMessagePresentationFallbackText({
			text: params.text ?? void 0,
			presentation
		});
		if (fallback.trim()) return fallback;
	}
	if (!interactive) return text;
	const interactivePresentation = interactiveReplyToPresentation(interactive);
	if (!interactivePresentation) return text;
	const fallback = renderMessagePresentationFallbackText({ presentation: interactivePresentation });
	return fallback.trim() ? fallback : text;
}
//#endregion
export { resolveTelegramInteractiveTextFallback as t };
