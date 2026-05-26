import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
//#region src/interactive/payload.ts
function normalizeButtonStyle(value) {
	const style = normalizeOptionalLowercaseString(value);
	return style === "primary" || style === "secondary" || style === "success" || style === "danger" ? style : void 0;
}
function normalizePresentationTone(value) {
	const tone = normalizeOptionalLowercaseString(value);
	return tone === "info" || tone === "success" || tone === "warning" || tone === "danger" || tone === "neutral" ? tone : void 0;
}
function toRecord(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	return raw;
}
function normalizeButton(raw) {
	const record = toRecord(raw);
	if (!record) return;
	const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
	const value = normalizeOptionalString(record.value) ?? normalizeOptionalString(record.callbackData) ?? normalizeOptionalString(record.callback_data);
	const url = normalizeOptionalString(record.url);
	const webAppUrl = normalizeOptionalString((toRecord(record.webApp) ?? toRecord(record.web_app))?.url);
	if (!label || !value && !url && !webAppUrl) return;
	const priority = typeof record.priority === "number" && Number.isFinite(record.priority) ? record.priority : void 0;
	return {
		label,
		...value ? { value } : {},
		...url ? { url } : {},
		...webAppUrl ? { webApp: { url: webAppUrl } } : {},
		...priority !== void 0 ? { priority } : {},
		...record.disabled === true ? { disabled: true } : {},
		...record.reusable === true ? { reusable: true } : {},
		style: normalizeButtonStyle(record.style)
	};
}
function normalizeOption(raw) {
	const record = toRecord(raw);
	if (!record) return;
	const label = normalizeOptionalString(record.label) ?? normalizeOptionalString(record.text);
	const value = normalizeOptionalString(record.value);
	if (!label || !value) return;
	return {
		label,
		value
	};
}
function normalizeList(value, normalizeEntry) {
	return Array.isArray(value) ? value.map((entry) => normalizeEntry(entry)).filter((entry) => Boolean(entry)) : [];
}
function normalizeInteractiveBlock(raw) {
	const record = toRecord(raw);
	if (!record) return;
	const type = normalizeOptionalLowercaseString(record.type);
	if (type === "text") {
		const text = normalizeOptionalString(record.text);
		return text ? {
			type: "text",
			text
		} : void 0;
	}
	if (type === "buttons") {
		const buttons = normalizeList(record.buttons, normalizeButton);
		return buttons.length > 0 ? {
			type: "buttons",
			buttons
		} : void 0;
	}
	if (type === "select") {
		const options = normalizeList(record.options, normalizeOption);
		return options.length > 0 ? {
			type: "select",
			placeholder: normalizeOptionalString(record.placeholder),
			options
		} : void 0;
	}
}
/**
* @deprecated Use normalizeMessagePresentation.
*/
function normalizeInteractiveReply(raw) {
	const record = toRecord(raw);
	if (!record) return;
	const blocks = normalizeList(record.blocks, normalizeInteractiveBlock);
	return blocks.length > 0 ? { blocks } : void 0;
}
function normalizePresentationBlock(raw) {
	const record = toRecord(raw);
	if (!record) return;
	const type = normalizeOptionalLowercaseString(record.type);
	if (type === "text" || type === "context") {
		const text = normalizeOptionalString(record.text);
		return text ? {
			type,
			text
		} : void 0;
	}
	if (type === "divider") return { type: "divider" };
	if (type === "buttons") {
		const buttons = normalizeList(record.buttons, normalizeButton);
		return buttons.length > 0 ? {
			type: "buttons",
			buttons
		} : void 0;
	}
	if (type === "select") {
		const options = normalizeList(record.options, normalizeOption);
		return options.length > 0 ? {
			type: "select",
			placeholder: normalizeOptionalString(record.placeholder),
			options
		} : void 0;
	}
}
function normalizeMessagePresentation(raw) {
	const record = toRecord(raw);
	if (!record) return;
	const blocks = normalizeList(record.blocks, normalizePresentationBlock);
	const title = normalizeOptionalString(record.title);
	if (!title && blocks.length === 0) return;
	return {
		...title ? { title } : {},
		tone: normalizePresentationTone(record.tone),
		blocks
	};
}
/**
* @deprecated Use hasMessagePresentationBlocks.
*/
function hasInteractiveReplyBlocks(value) {
	return Boolean(normalizeInteractiveReply(value));
}
function hasMessagePresentationBlocks(value) {
	return Boolean(normalizeMessagePresentation(value));
}
/**
* @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
*/
function presentationToInteractiveReply(presentation) {
	const blocks = [];
	if (presentation.title) blocks.push({
		type: "text",
		text: presentation.title
	});
	for (const block of presentation.blocks) {
		if (block.type === "text" || block.type === "context") {
			blocks.push({
				type: "text",
				text: block.text
			});
			continue;
		}
		if (block.type === "buttons") {
			const buttons = block.buttons.filter((button) => button.value || button.url || button.webApp || button.web_app).map((button) => {
				const interactiveButton = {
					label: button.label,
					style: button.style
				};
				if (button.value) interactiveButton.value = button.value;
				if (button.url) interactiveButton.url = button.url;
				const webApp = button.webApp ?? button.web_app;
				if (webApp) interactiveButton.webApp = webApp;
				if (button.priority !== void 0) interactiveButton.priority = button.priority;
				if (button.disabled === true) interactiveButton.disabled = true;
				if (button.reusable === true) interactiveButton.reusable = true;
				return interactiveButton;
			});
			if (buttons.length > 0) blocks.push({
				type: "buttons",
				buttons
			});
			continue;
		}
		if (block.type === "select") blocks.push({
			type: "select",
			placeholder: block.placeholder,
			options: block.options
		});
	}
	return blocks.length > 0 ? { blocks } : void 0;
}
function isMessagePresentationInteractiveBlock(block) {
	return block.type === "buttons" || block.type === "select";
}
/**
* @deprecated Avoid producing InteractiveReply payloads; send MessagePresentation directly.
*/
function presentationToInteractiveControlsReply(presentation) {
	return presentationToInteractiveReply({ blocks: presentation.blocks.filter(isMessagePresentationInteractiveBlock) });
}
/**
* @deprecated Legacy bridge for old InteractiveReply payloads. New producers should send MessagePresentation.
*/
function interactiveReplyToPresentation(interactive) {
	const blocks = interactive.blocks.map((block) => {
		if (block.type === "text") return {
			type: "text",
			text: block.text
		};
		if (block.type === "buttons") return {
			type: "buttons",
			buttons: block.buttons
		};
		return {
			type: "select",
			placeholder: block.placeholder,
			options: block.options
		};
	});
	return blocks.length > 0 ? { blocks } : void 0;
}
function renderMessagePresentationFallbackText(params) {
	const lines = [];
	const text = normalizeOptionalString(params.text);
	if (text) lines.push(text);
	const presentation = params.presentation;
	if (!presentation) return lines.join("\n\n");
	if (presentation.title) lines.push(presentation.title);
	for (const block of presentation.blocks) {
		if (block.type === "text" || block.type === "context") {
			lines.push(block.text);
			continue;
		}
		if (block.type === "buttons") {
			const labels = block.buttons.map((button) => {
				const targetUrl = button.url ?? button.webApp?.url ?? button.web_app?.url;
				return targetUrl ? `${button.label}: ${targetUrl}` : button.label;
			}).filter(Boolean);
			if (labels.length > 0) lines.push(labels.map((label) => `- ${label}`).join("\n"));
			continue;
		}
		if (block.type === "select") {
			const labels = block.options.map((option) => option.label).filter(Boolean);
			if (labels.length > 0) {
				const heading = block.placeholder ? `${block.placeholder}:` : "Options:";
				lines.push(`${heading}\n${labels.map((label) => `- ${label}`).join("\n")}`);
			}
		}
	}
	return lines.join("\n\n") || normalizeOptionalString(params.emptyFallback) || "";
}
function hasReplyChannelData(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}
function hasReplyContent(params) {
	const text = normalizeOptionalString(params.text);
	const mediaUrl = normalizeOptionalString(params.mediaUrl);
	return Boolean(text || mediaUrl || params.mediaUrls?.some((entry) => Boolean(normalizeOptionalString(entry))) || hasMessagePresentationBlocks(params.presentation) || hasInteractiveReplyBlocks(params.interactive) || params.hasChannelData || params.extraContent);
}
function hasReplyPayloadContent(payload, options) {
	return hasReplyContent({
		text: options?.trimText ? payload.text?.trim() : payload.text,
		mediaUrl: payload.mediaUrl,
		mediaUrls: payload.mediaUrls,
		interactive: payload.interactive,
		presentation: payload.presentation,
		hasChannelData: options?.hasChannelData ?? hasReplyChannelData(payload.channelData),
		extraContent: options?.extraContent
	});
}
/**
* @deprecated Use renderMessagePresentationFallbackText with MessagePresentation.
*/
function resolveInteractiveTextFallback(params) {
	if (normalizeOptionalString(params.text)) return params.text;
	return (params.interactive?.blocks ?? []).filter((block) => block.type === "text").map((block) => block.text.trim()).filter(Boolean).join("\n\n") || params.text;
}
//#endregion
export { hasReplyPayloadContent as a, normalizeInteractiveReply as c, presentationToInteractiveReply as d, renderMessagePresentationFallbackText as f, hasReplyContent as i, normalizeMessagePresentation as l, hasMessagePresentationBlocks as n, interactiveReplyToPresentation as o, resolveInteractiveTextFallback as p, hasReplyChannelData as r, isMessagePresentationInteractiveBlock as s, hasInteractiveReplyBlocks as t, presentationToInteractiveControlsReply as u };
