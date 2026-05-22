import { c as normalizeInteractiveReply } from "./payload-ClLle4XB.js";
import { t as reduceInteractiveReply } from "./interactive-81tHp6M_.js";
import { n as sanitizeTelegramCallbackData } from "./approval-callback-data-B3fxfOVl.js";
//#region extensions/telegram/src/button-types.ts
const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;
function toTelegramButtonStyle(style) {
	return style === "danger" || style === "success" || style === "primary" ? style : void 0;
}
function chunkInteractiveButtons(buttons, rows) {
	for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
		const row = buttons.slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE).flatMap((button) => {
			if (!button.value) return [];
			const callbackData = sanitizeTelegramCallbackData(button.value);
			if (!callbackData) return [];
			return [{
				text: button.label,
				callback_data: callbackData,
				style: toTelegramButtonStyle(button.style)
			}];
		});
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
