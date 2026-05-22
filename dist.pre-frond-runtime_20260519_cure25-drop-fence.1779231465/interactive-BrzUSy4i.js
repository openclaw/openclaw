//#region src/channels/plugins/outbound/presentation-limits.ts
function positiveInteger(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function truncateText(value, maxLength) {
	const limit = positiveInteger(maxLength);
	if (!limit) return value;
	const chars = Array.from(value);
	return chars.length > limit ? chars.slice(0, limit).join("") : value;
}
function truncateUtf8Bytes(value, limit) {
	let bytes = 0;
	let result = "";
	for (const char of value) {
		const nextBytes = utf8ByteLength(char);
		if (bytes + nextBytes > limit) break;
		bytes += nextBytes;
		result += char;
	}
	return result;
}
function truncatePresentationText(value, limits) {
	const limit = positiveInteger(limits?.maxLength);
	if (!limit) return value;
	if (limits?.encoding === "utf8-bytes") return truncateUtf8Bytes(value, limit);
	if (limits?.encoding === "utf16-units") return value.length > limit ? value.slice(0, limit) : value;
	const chars = Array.from(value);
	return chars.length > limit ? chars.slice(0, limit).join("") : value;
}
function utf8ByteLength(value) {
	return Buffer.byteLength(value, "utf8");
}
function fitsByteLimit(value, maxBytes) {
	const limit = positiveInteger(maxBytes);
	return !value || !limit || utf8ByteLength(value) <= limit;
}
function fallbackListBlock(params) {
	const labels = params.labels.map((label) => truncateText(label, params.maxLabelLength).trim()).filter(Boolean);
	return labels.length > 0 ? {
		type: params.blockType,
		text: `${params.heading}:\n${labels.map((label) => `- ${label}`).join("\n")}`
	} : void 0;
}
function buttonFallbackLabel(button, maxLabelLength) {
	const label = truncateText(button.label, maxLabelLength);
	const target = button.url ?? button.webApp?.url ?? button.web_app?.url;
	return target ? `${label}: ${target}` : label;
}
function actionCapacity(limits) {
	const maxActions = positiveInteger(limits?.maxActions);
	const maxRows = positiveInteger(limits?.maxRows);
	const maxActionsPerRow = positiveInteger(limits?.maxActionsPerRow);
	const rowCapacity = maxRows && maxActionsPerRow ? maxRows * maxActionsPerRow : void 0;
	if (maxActions && rowCapacity) return Math.min(maxActions, rowCapacity);
	return maxActions ?? rowCapacity;
}
function buttonCapacityAfterReservedSelects(limits, reservedSelects) {
	const maxActions = positiveInteger(limits?.maxActions);
	const maxRows = positiveInteger(limits?.maxRows);
	const maxActionsPerRow = positiveInteger(limits?.maxActionsPerRow);
	const remainingActions = maxActions === void 0 ? void 0 : Math.max(0, maxActions - reservedSelects);
	const remainingRows = maxRows === void 0 ? void 0 : Math.max(0, maxRows - reservedSelects);
	const rowCapacity = remainingRows !== void 0 && maxActionsPerRow !== void 0 ? remainingRows * maxActionsPerRow : void 0;
	if (remainingActions !== void 0 && rowCapacity !== void 0) return Math.min(remainingActions, rowCapacity);
	return remainingActions ?? rowCapacity;
}
function createActionBudget(limits) {
	return {
		remainingActions: positiveInteger(limits?.maxActions),
		remainingRows: positiveInteger(limits?.maxRows),
		maxActionsPerRow: positiveInteger(limits?.maxActionsPerRow)
	};
}
function buttonCapacity(budget) {
	if (budget.remainingActions === 0 || budget.remainingRows === 0) return 0;
	const rowCapacity = budget.remainingRows && budget.maxActionsPerRow ? budget.remainingRows * budget.maxActionsPerRow : void 0;
	if (budget.remainingActions !== void 0 && rowCapacity !== void 0) return Math.min(budget.remainingActions, rowCapacity);
	return budget.remainingActions ?? rowCapacity;
}
function consumeButtonBudget(budget, count) {
	if (count <= 0) return;
	if (budget.remainingActions !== void 0) budget.remainingActions = Math.max(0, budget.remainingActions - count);
	if (budget.remainingRows !== void 0) {
		const perRow = budget.maxActionsPerRow ?? count;
		budget.remainingRows = Math.max(0, budget.remainingRows - Math.ceil(count / perRow));
	}
}
function chunkButtons(buttons, maxActionsPerRow) {
	const rowSize = positiveInteger(maxActionsPerRow);
	if (!rowSize) return buttons.length > 0 ? [[...buttons]] : [];
	const rows = [];
	for (let index = 0; index < buttons.length; index += rowSize) rows.push(buttons.slice(index, index + rowSize));
	return rows;
}
function hasActionSlotBudget(budget) {
	return budget.remainingActions !== 0 && budget.remainingRows !== 0;
}
function consumeSelectBudget(budget) {
	if (budget.remainingActions !== void 0) budget.remainingActions = Math.max(0, budget.remainingActions - 1);
	if (budget.remainingRows !== void 0) budget.remainingRows = Math.max(0, budget.remainingRows - 1);
}
function adaptButton(button, limits) {
	const hasLinkTarget = Boolean(button.url || button.webApp || button.web_app);
	const valueFits = fitsByteLimit(button.value, limits?.maxValueBytes);
	if (!valueFits && !hasLinkTarget || button.disabled === true && limits?.supportsDisabled !== true) return;
	const adapted = {
		...button,
		label: truncateText(button.label, limits?.maxLabelLength)
	};
	if (!valueFits) delete adapted.value;
	if (limits?.supportsStyles === false) delete adapted.style;
	return adapted;
}
function adaptButtonsBlock(block, limits, budget, fallbackBlockType, buttonSelection) {
	const capacity = buttonCapacity(budget);
	const candidates = block.buttons.map((button) => ({
		original: button,
		adapted: adaptButton(button, limits)
	}));
	const renderableCandidates = candidates.filter((candidate) => Boolean(candidate.adapted));
	const eligibleCandidates = buttonSelection ? renderableCandidates.filter((candidate) => buttonSelection.has(candidate.original)) : renderableCandidates;
	const selectedCandidates = capacity !== void 0 && eligibleCandidates.length > capacity ? eligibleCandidates.map((candidate, index) => ({
		candidate,
		index
	})).toSorted((left, right) => {
		return (right.candidate.adapted.priority ?? 0) - (left.candidate.adapted.priority ?? 0) || left.index - right.index;
	}).slice(0, capacity).map((entry) => entry.candidate) : eligibleCandidates;
	const selected = new Set(selectedCandidates);
	const buttons = selectedCandidates.map((candidate) => candidate.adapted);
	const droppedLabels = candidates.filter((candidate) => !candidate.adapted || !selected.has(candidate)).map((candidate) => buttonFallbackLabel(candidate.original, limits?.maxLabelLength));
	consumeButtonBudget(budget, buttons.length);
	const fallback = fallbackListBlock({
		blockType: fallbackBlockType,
		heading: "Actions",
		labels: droppedLabels
	});
	if (buttons.length === 0) return fallback ? [fallback] : [];
	const blocks = chunkButtons(buttons, limits?.maxActionsPerRow).map((row) => ({
		type: "buttons",
		buttons: row
	}));
	if (fallback) blocks.push(fallback);
	return blocks;
}
function appendAdaptedButtonsBlock(blocks, block, limits, budget, fallbackBlockType, buttonSelection) {
	blocks.push(...adaptButtonsBlock(block, limits, budget, fallbackBlockType, buttonSelection));
}
function adaptOption(option, limits) {
	if (!fitsByteLimit(option.value, limits?.maxValueBytes)) return;
	return {
		...option,
		label: truncateText(option.label, limits?.maxLabelLength)
	};
}
function adaptSelectBlock(block, limits, budget, fallbackBlockType) {
	const candidates = block.options.map((option) => ({
		original: option,
		adapted: adaptOption(option, limits)
	}));
	const renderableCandidates = candidates.filter((candidate) => Boolean(candidate.adapted));
	const maxOptions = positiveInteger(limits?.maxOptions);
	const selectedCandidates = maxOptions ? renderableCandidates.slice(0, maxOptions) : renderableCandidates;
	const selected = new Set(selectedCandidates);
	const options = selectedCandidates.map((candidate) => candidate.adapted);
	const canRenderSelect = options.length > 0 && hasActionSlotBudget(budget);
	const fallback = fallbackListBlock({
		blockType: fallbackBlockType,
		heading: block.placeholder ?? "Options",
		labels: (canRenderSelect ? candidates.filter((candidate) => !candidate.adapted || !selected.has(candidate)) : candidates).map((candidate) => candidate.original.label),
		maxLabelLength: limits?.maxLabelLength
	});
	if (!canRenderSelect) return fallback ? [fallback] : [];
	consumeSelectBudget(budget);
	const blocks = [{
		type: "select",
		placeholder: truncateText(block.placeholder ?? "", limits?.maxLabelLength) || void 0,
		options
	}];
	if (fallback) blocks.push(fallback);
	return blocks;
}
function countRenderableSelectBlocks(blocks, capabilities, limits) {
	if (capabilities?.selects === false) return 0;
	return blocks.filter((block) => {
		if (block.type !== "select") return false;
		const maxOptions = positiveInteger(limits?.maxOptions);
		return block.options.map((option) => adaptOption(option, limits)).filter(Boolean).slice(0, maxOptions ?? void 0).length > 0;
	}).length;
}
function createGlobalButtonSelection(params) {
	if (params.capabilities?.buttons === false) return;
	const reservedSelectSlots = countRenderableSelectBlocks(params.presentation.blocks, params.capabilities, params.selectLimits);
	const capacity = buttonCapacityAfterReservedSelects(params.limits, reservedSelectSlots);
	if (capacity === void 0) return;
	const candidates = params.presentation.blocks.flatMap((block) => {
		if (block.type !== "buttons") return [];
		return block.buttons.map((button) => ({
			original: button,
			adapted: adaptButton(button, params.limits)
		})).filter((candidate) => Boolean(candidate.adapted));
	});
	if (candidates.length <= capacity) return;
	return new Set(candidates.map((candidate, index) => ({
		candidate,
		index
	})).toSorted((left, right) => {
		return (right.candidate.adapted.priority ?? 0) - (left.candidate.adapted.priority ?? 0) || left.index - right.index;
	}).slice(0, capacity).map((entry) => entry.candidate.original));
}
function adaptTextBlock(block, limits) {
	if (block.type === "text" || block.type === "context") return {
		...block,
		text: truncatePresentationText(block.text, limits)
	};
	return block;
}
/**
* Adapt a portable presentation to the target channel's advertised capabilities.
*
* Unsupported controls are downgraded to text/context fallback blocks where possible, and
* labels, values, rows, options, styles, disabled state, and text are clipped to channel limits.
*/
function adaptMessagePresentationForChannel(params) {
	const capabilities = params.capabilities;
	const limits = params.capabilities?.limits;
	const actionBudget = createActionBudget(limits?.actions);
	const fallbackBlockType = capabilities?.context === false ? "text" : "context";
	const buttonSelection = createGlobalButtonSelection({
		presentation: params.presentation,
		capabilities,
		limits: limits?.actions,
		selectLimits: limits?.selects
	});
	const blocks = [];
	for (const block of params.presentation.blocks) {
		if (block.type === "buttons") {
			if (capabilities?.buttons === false) {
				const fallback = fallbackListBlock({
					blockType: fallbackBlockType,
					heading: "Actions",
					labels: block.buttons.map((button) => buttonFallbackLabel(button, limits?.actions?.maxLabelLength))
				});
				if (fallback) blocks.push(fallback);
				continue;
			}
			appendAdaptedButtonsBlock(blocks, block, limits?.actions, actionBudget, fallbackBlockType, buttonSelection);
			continue;
		}
		if (block.type === "select") {
			if (capabilities?.selects === false) {
				const fallback = fallbackListBlock({
					blockType: fallbackBlockType,
					heading: block.placeholder ?? "Options",
					labels: block.options.map((option) => option.label),
					maxLabelLength: limits?.selects?.maxLabelLength
				});
				if (fallback) blocks.push(fallback);
				continue;
			}
			blocks.push(...adaptSelectBlock(block, limits?.selects, actionBudget, fallbackBlockType));
			continue;
		}
		if (block.type === "context" && capabilities?.context === false) {
			blocks.push({
				type: "text",
				text: block.text
			});
			continue;
		}
		if (block.type === "divider" && capabilities?.divider === false) continue;
		blocks.push(block);
	}
	return {
		...params.presentation,
		...params.presentation.title ? { title: truncatePresentationText(params.presentation.title, limits?.text) } : {},
		blocks: blocks.map((block) => adaptTextBlock(block, limits?.text))
	};
}
/** Return the subset of buttons that can still be rendered under action limits. */
function applyPresentationActionLimits(buttons, capabilities) {
	return adaptButtonsBlock({
		type: "buttons",
		buttons: [...buttons]
	}, capabilities?.limits?.actions, createActionBudget(capabilities?.limits?.actions), capabilities?.context === false ? "text" : "context", void 0).flatMap((entry) => entry.type === "buttons" ? entry.buttons : []);
}
/** Resolve an action page size that leaves room for reserved actions on the target channel. */
function presentationPageSize(capabilities, reservedActions = 0, maxPageSize = Number.POSITIVE_INFINITY) {
	const capacity = actionCapacity(capabilities?.limits?.actions);
	const remaining = Math.max(0, (capacity ?? maxPageSize) - Math.max(0, reservedActions));
	return Math.max(1, Math.min(remaining || 1, maxPageSize));
}
//#endregion
//#region src/channels/plugins/outbound/interactive.ts
/**
* @deprecated Use MessagePresentation helpers for new rendering paths.
*/
function reduceInteractiveReply(interactive, initialState, reduce) {
	let state = initialState;
	for (const [index, block] of (interactive?.blocks ?? []).entries()) state = reduce(state, block, index);
	return state;
}
//#endregion
export { presentationPageSize as i, adaptMessagePresentationForChannel as n, applyPresentationActionLimits as r, reduceInteractiveReply as t };
