import { c as normalizeInteractiveReply } from "./payload-BGXKFAMn.js";
import { t as reduceInteractiveReply } from "./interactive-CxNVmvtG.js";
import { n as sanitizeTelegramCallbackData } from "./approval-callback-data-DdzYN9Zr.js";
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
	return callbackData ? {
		text: button.label,
		callback_data: callbackData,
		style
	} : void 0;
}
function chunkInteractiveButtons(buttons, rows) {
	for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
		const row = buttons.slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE).map(toTelegramInlineButton).filter((button) => Boolean(button));
		if (row.length > 0) rows.push(row);
	}
}
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
function resolveTelegramInlineButtons(params) {
	return params.buttons ?? buildTelegramInteractiveButtons(normalizeInteractiveReply(params.interactive));
}
//#endregion
export { resolveTelegramInlineButtons as t };
