import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { presentationToInteractiveReply, reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
//#region extensions/discord/src/shared-interactive.ts
var shared_interactive_exports = /* @__PURE__ */ __exportAll({
	buildDiscordInteractiveComponents: () => buildDiscordInteractiveComponents,
	buildDiscordPresentationComponents: () => buildDiscordPresentationComponents
});
function resolveDiscordInteractiveButtonStyle(style) {
	return style ?? "secondary";
}
const DISCORD_INTERACTIVE_BUTTON_ROW_SIZE = 5;
function buildDiscordInteractiveComponents(interactive) {
	const blocks = reduceInteractiveReply(interactive, [], (state, block) => {
		if (block.type === "text") {
			const text = block.text.trim();
			if (text) state.push({
				type: "text",
				text
			});
			return state;
		}
		if (block.type === "buttons") {
			if (block.buttons.length === 0) return state;
			for (let index = 0; index < block.buttons.length; index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE) state.push({
				type: "actions",
				buttons: block.buttons.slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE).map((button) => {
					const spec = {
						label: button.label,
						style: button.url ? "link" : resolveDiscordInteractiveButtonStyle(button.style)
					};
					if (button.value) spec.callbackData = button.value;
					if (button.url) spec.url = button.url;
					return spec;
				})
			});
			return state;
		}
		if (block.type === "select" && block.options.length > 0) state.push({
			type: "actions",
			select: {
				type: "string",
				placeholder: block.placeholder,
				options: block.options.map((option) => ({
					label: option.label,
					value: option.value
				}))
			}
		});
		return state;
	});
	return blocks.length > 0 ? { blocks } : void 0;
}
function buildDiscordPresentationComponents(presentation) {
	if (!presentation) return;
	const spec = { blocks: [] };
	if (presentation.title) spec.blocks?.push({
		type: "text",
		text: presentation.title
	});
	for (const block of presentation.blocks) {
		if (block.type === "text" || block.type === "context") {
			const text = block.text.trim();
			if (text) spec.blocks?.push({
				type: "text",
				text: block.type === "context" ? `-# ${text}` : text
			});
			continue;
		}
		if (block.type === "divider") {
			spec.blocks?.push({ type: "separator" });
			continue;
		}
	}
	const interactiveSpec = buildDiscordInteractiveComponents(presentationToInteractiveReply({ blocks: presentation.blocks.filter((block) => block.type === "buttons" || block.type === "select") }));
	if (interactiveSpec?.blocks?.length) spec.blocks?.push(...interactiveSpec.blocks);
	return spec.blocks?.length ? spec : void 0;
}
//#endregion
export { buildDiscordPresentationComponents as n, shared_interactive_exports as r, buildDiscordInteractiveComponents as t };
