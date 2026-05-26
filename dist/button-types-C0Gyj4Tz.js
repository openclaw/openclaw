import { c as normalizeInteractiveReply, l as normalizeMessagePresentation, s as isMessagePresentationInteractiveBlock } from "./payload-BDV15CYA.js";
import { t as reduceInteractiveReply } from "./interactive-DO_VR-vH.js";
import { n as sanitizeTelegramCallbackData } from "./approval-callback-data-BkjSkkP6.js";
//#region extensions/telegram/src/button-types.ts
const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;
function toTelegramButtonStyle(style) {
	return style === "danger" || style === "success" || style === "primary" ? style : void 0;
}
function toTelegramInlineButton(button) {
	const style = toTelegramButtonStyle(button.style);
	if (button.url) return {
		text: button.label,
		url: button.url,
		style
	};
	const callbackData = button.value ? sanitizeTelegramCallbackData(button.value) : void 0;
	if (callbackData) return {
		text: button.label,
		callback_data: callbackData,
		style
	};
	if (button.webApp?.url) return {
		text: button.label,
		web_app: { url: button.webApp.url },
		style
	};
}
function chunkInteractiveButtons(buttons, rows) {
	for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
		const row = buttons.slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE).map(toTelegramInlineButton).filter((button) => Boolean(button));
		if (row.length > 0) rows.push(row);
	}
}
/**
* @deprecated Use buildTelegramPresentationButtons with MessagePresentation.
*/
function buildTelegramInteractiveButtons(interactive) {
	const rows = reduceInteractiveReply(interactive, [], (state, block) => {
		if (block.type === "buttons") {
			chunkInteractiveButtons(block.buttons, state);
			return state;
		}
		if (block.type === "select") chunkInteractiveButtons(block.options.map((option) => ({
			label: option.label,
			value: option.value
		})), state);
		return state;
	});
	return rows.length > 0 ? rows : void 0;
}
/** Convert portable presentation controls to Telegram inline keyboard rows. */
function buildTelegramPresentationButtons(presentation) {
	const rows = [];
	for (const block of presentation?.blocks ?? []) {
		if (!isMessagePresentationInteractiveBlock(block)) continue;
		if (block.type === "buttons") {
			chunkInteractiveButtons(block.buttons, rows);
			continue;
		}
		chunkInteractiveButtons(block.options.map((option) => ({
			label: option.label,
			value: option.value
		})), rows);
	}
	return rows.length > 0 ? rows : void 0;
}
/** Resolve Telegram inline buttons, preserving explicit and legacy button precedence. */
function resolveTelegramInlineButtons(params) {
	return params.buttons ?? buildTelegramInteractiveButtons(normalizeInteractiveReply(params.interactive)) ?? buildTelegramPresentationButtons(normalizeMessagePresentation(params.presentation));
}
//#endregion
export { resolveTelegramInlineButtons as t };
