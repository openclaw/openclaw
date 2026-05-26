import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as presentationToInteractiveControlsReply } from "./payload-BGXKFAMn.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { t as reduceInteractiveReply } from "./interactive-CxNVmvtG.js";
import { i as truncateSlackText } from "./thread-ts-DWLXPVhT.js";
//#region extensions/slack/src/reply-action-ids.ts
const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";
//#endregion
//#region extensions/slack/src/blocks-render.ts
const SLACK_SECTION_TEXT_MAX = 3e3;
const SLACK_PLAIN_TEXT_MAX = 75;
const SLACK_OPTION_VALUE_MAX = 150;
const SLACK_BUTTON_VALUE_MAX = 2e3;
const SLACK_BUTTON_URL_MAX = 3e3;
const SLACK_STATIC_SELECT_OPTIONS_MAX = 100;
const SLACK_ACTION_BLOCK_ELEMENTS_MAX = 25;
function buildSlackReplyButtonActionId(buttonIndex, choiceIndex) {
	return `${SLACK_REPLY_BUTTON_ACTION_ID}:${String(buttonIndex)}:${String(choiceIndex + 1)}`;
}
function buildSlackReplySelectActionId(selectIndex) {
	return `${SLACK_REPLY_SELECT_ACTION_ID}:${String(selectIndex)}`;
}
function resolveSlackButtonStyle(style) {
	if (style === "primary" || style === "danger") return style;
	if (style === "success") return "primary";
}
function isWithinSlackLimit(value, maxLength) {
	return value.length <= maxLength;
}
function readSlackBlockId(block) {
	const value = block.block_id;
	return typeof value === "string" ? value : void 0;
}
function readSlackOpenClawBlockIndex(blockId, prefix) {
	if (!blockId.startsWith(prefix)) return;
	const value = Number.parseInt(blockId.slice(prefix.length), 10);
	return Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function resolveSlackInteractiveBlockOffsets(blocks) {
	let buttonIndexOffset = 0;
	let selectIndexOffset = 0;
	for (const block of blocks ?? []) {
		const blockId = readSlackBlockId(block);
		if (!blockId) continue;
		buttonIndexOffset = Math.max(buttonIndexOffset, readSlackOpenClawBlockIndex(blockId, "openclaw_reply_buttons_") ?? 0);
		selectIndexOffset = Math.max(selectIndexOffset, readSlackOpenClawBlockIndex(blockId, "openclaw_reply_select_") ?? 0);
	}
	return {
		buttonIndexOffset,
		selectIndexOffset
	};
}
function buildSlackInteractiveBlocks(interactive, options = {}) {
	return reduceInteractiveReply(interactive, {
		blocks: [],
		buttonIndex: options.buttonIndexOffset ?? 0,
		selectIndex: options.selectIndexOffset ?? 0
	}, (state, block) => {
		if (block.type === "text") {
			const trimmed = block.text.trim();
			if (!trimmed) return state;
			state.blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: truncateSlackText(trimmed, SLACK_SECTION_TEXT_MAX)
				}
			});
			return state;
		}
		if (block.type === "buttons") {
			const elements = block.buttons.flatMap((button, choiceIndex) => {
				const value = button.value && isWithinSlackLimit(button.value, SLACK_BUTTON_VALUE_MAX) ? button.value : void 0;
				const url = button.url && isWithinSlackLimit(button.url, SLACK_BUTTON_URL_MAX) ? button.url : void 0;
				if (!value && !url) return [];
				const style = resolveSlackButtonStyle(button.style);
				return [{
					type: "button",
					action_id: buildSlackReplyButtonActionId(state.buttonIndex + 1, choiceIndex),
					text: {
						type: "plain_text",
						text: truncateSlackText(button.label, SLACK_PLAIN_TEXT_MAX),
						emoji: true
					},
					...value ? { value } : {},
					...url ? { url } : {},
					...style ? { style } : {}
				}];
			}).slice(0, SLACK_ACTION_BLOCK_ELEMENTS_MAX);
			if (elements.length === 0) return state;
			state.blocks.push({
				type: "actions",
				block_id: `openclaw_reply_buttons_${++state.buttonIndex}`,
				elements
			});
			return state;
		}
		const options = block.options.filter((option) => isWithinSlackLimit(option.value, SLACK_OPTION_VALUE_MAX)).slice(0, SLACK_STATIC_SELECT_OPTIONS_MAX);
		if (options.length === 0) return state;
		state.blocks.push({
			type: "actions",
			block_id: `openclaw_reply_select_${++state.selectIndex}`,
			elements: [{
				type: "static_select",
				action_id: buildSlackReplySelectActionId(state.selectIndex),
				placeholder: {
					type: "plain_text",
					text: truncateSlackText(normalizeOptionalString(block.placeholder) ?? "Choose an option", SLACK_PLAIN_TEXT_MAX),
					emoji: true
				},
				options: options.map((option, _choiceIndex) => ({
					text: {
						type: "plain_text",
						text: truncateSlackText(option.label, SLACK_PLAIN_TEXT_MAX),
						emoji: true
					},
					value: option.value
				}))
			}]
		});
		return state;
	}).blocks;
}
function buildSlackPresentationBlocks(presentation, options = {}) {
	if (!presentation) return [];
	const blocks = [];
	if (presentation.title) blocks.push({
		type: "header",
		text: {
			type: "plain_text",
			text: truncateSlackText(presentation.title, 150),
			emoji: true
		}
	});
	for (const block of presentation.blocks) {
		if (block.type === "text" || block.type === "context") {
			const text = block.text.trim();
			if (!text) continue;
			if (block.type === "context") blocks.push({
				type: "context",
				elements: [{
					type: "mrkdwn",
					text: truncateSlackText(text, SLACK_SECTION_TEXT_MAX)
				}]
			});
			else blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: truncateSlackText(text, SLACK_SECTION_TEXT_MAX)
				}
			});
			continue;
		}
		if (block.type === "divider") blocks.push({ type: "divider" });
	}
	const interactive = presentationToInteractiveControlsReply(presentation);
	blocks.push(...buildSlackInteractiveBlocks(interactive, options));
	return blocks;
}
//#endregion
export { SLACK_REPLY_SELECT_ACTION_ID as a, SLACK_REPLY_BUTTON_ACTION_ID as i, buildSlackPresentationBlocks as n, resolveSlackInteractiveBlockOffsets as r, buildSlackInteractiveBlocks as t };
