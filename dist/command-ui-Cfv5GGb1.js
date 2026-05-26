import { t as fitsTelegramCallbackData } from "./approval-callback-data-BkjSkkP6.js";
//#region extensions/telegram/src/model-buttons.ts
/**
* Telegram inline button utilities for model selection.
*
* Callback data patterns (max 64 bytes for Telegram):
* - mdl_prov              - show providers list
* - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
* - mdl_sel_{provider/id} - select model (standard)
* - mdl_sel/{model}       - select model (compact fallback when standard is >64 bytes)
* - mdl_back              - back to providers list
*/
const MODELS_PAGE_SIZE = 8;
const CALLBACK_PREFIX = {
	providers: "mdl_prov",
	back: "mdl_back",
	list: "mdl_list_",
	selectStandard: "mdl_sel_",
	selectCompact: "mdl_sel/"
};
/**
* Parse a model callback_data string into a structured object.
* Returns null if the data doesn't match a known pattern.
*/
function parseModelCallbackData(data) {
	const trimmed = data.trim();
	if (!trimmed.startsWith("mdl_")) return null;
	if (trimmed === CALLBACK_PREFIX.providers || trimmed === CALLBACK_PREFIX.back) return { type: trimmed === CALLBACK_PREFIX.providers ? "providers" : "back" };
	const listMatch = trimmed.match(/^mdl_list_([a-z0-9_.-]+)_(\d+)$/i);
	if (listMatch) {
		const [, provider, pageStr] = listMatch;
		const page = Number.parseInt(pageStr ?? "1", 10);
		if (provider && Number.isFinite(page) && page >= 1) return {
			type: "list",
			provider,
			page
		};
	}
	const compactSelMatch = trimmed.match(/^mdl_sel\/(.+)$/);
	if (compactSelMatch) {
		const modelRef = compactSelMatch[1];
		if (modelRef) return {
			type: "select",
			model: modelRef
		};
	}
	const selMatch = trimmed.match(/^mdl_sel_(.+)$/);
	if (selMatch) {
		const modelRef = selMatch[1];
		if (modelRef) {
			const slashIndex = modelRef.indexOf("/");
			if (slashIndex > 0 && slashIndex < modelRef.length - 1) return {
				type: "select",
				provider: modelRef.slice(0, slashIndex),
				model: modelRef.slice(slashIndex + 1)
			};
		}
	}
	return null;
}
function buildModelSelectionCallbackData(params) {
	const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
	if (fitsTelegramCallbackData(fullCallbackData)) return fullCallbackData;
	const compactCallbackData = `${CALLBACK_PREFIX.selectCompact}${params.model}`;
	return fitsTelegramCallbackData(compactCallbackData) ? compactCallbackData : null;
}
function resolveModelSelection(params) {
	if (params.callback.provider) return {
		kind: "resolved",
		provider: params.callback.provider,
		model: params.callback.model
	};
	const matchingProviders = params.providers.filter((id) => params.byProvider.get(id)?.has(params.callback.model));
	if (matchingProviders.length === 1) return {
		kind: "resolved",
		provider: matchingProviders[0],
		model: params.callback.model
	};
	return {
		kind: "ambiguous",
		model: params.callback.model,
		matchingProviders
	};
}
function isCurrentModelSelection(params) {
	const currentModel = params.currentModel?.trim();
	if (!currentModel) return false;
	return currentModel.includes("/") ? currentModel === `${params.provider}/${params.model}` : currentModel === params.model;
}
/**
* Build provider selection keyboard with 2 providers per row.
*/
function buildProviderKeyboard(providers) {
	if (providers.length === 0) return [];
	const rows = [];
	let currentRow = [];
	for (const provider of providers) {
		const button = {
			text: `${provider.id} (${provider.count})`,
			callback_data: `mdl_list_${provider.id}_1`
		};
		currentRow.push(button);
		if (currentRow.length === 2) {
			rows.push(currentRow);
			currentRow = [];
		}
	}
	if (currentRow.length > 0) rows.push(currentRow);
	return rows;
}
/**
* Build model list keyboard with pagination and back button.
*/
function buildModelsKeyboard(params) {
	const { provider, models, currentModel, currentPage, totalPages, modelNames } = params;
	const pageSize = params.pageSize ?? MODELS_PAGE_SIZE;
	if (models.length === 0) return [[{
		text: "<< Back",
		callback_data: CALLBACK_PREFIX.back
	}]];
	const rows = [];
	const startIndex = (currentPage - 1) * pageSize;
	const endIndex = Math.min(startIndex + pageSize, models.length);
	const pageModels = models.slice(startIndex, endIndex);
	for (const model of pageModels) {
		const callbackData = buildModelSelectionCallbackData({
			provider,
			model
		});
		if (!callbackData) continue;
		const isCurrentModel = isCurrentModelSelection({
			currentModel,
			provider,
			model
		});
		const fallbackLabel = model.includes("/") ? `${provider}/${model}` : model;
		const displayText = truncateModelId(modelNames?.get(`${provider}/${model}`) ?? fallbackLabel, 38);
		const text = isCurrentModel ? `${displayText} ✓` : displayText;
		rows.push([{
			text,
			callback_data: callbackData
		}]);
	}
	if (totalPages > 1) {
		const paginationRow = [];
		if (currentPage > 1) paginationRow.push({
			text: "◀ Prev",
			callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage - 1}`
		});
		paginationRow.push({
			text: `${currentPage}/${totalPages}`,
			callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage}`
		});
		if (currentPage < totalPages) paginationRow.push({
			text: "Next ▶",
			callback_data: `${CALLBACK_PREFIX.list}${provider}_${currentPage + 1}`
		});
		rows.push(paginationRow);
	}
	rows.push([{
		text: "<< Back",
		callback_data: CALLBACK_PREFIX.back
	}]);
	return rows;
}
/**
* Build "Browse providers" button for /model summary.
*/
function buildBrowseProvidersButton() {
	return [[{
		text: "Browse providers",
		callback_data: CALLBACK_PREFIX.providers
	}]];
}
/**
* Truncate model ID for display, preserving end if too long.
*/
function truncateModelId(modelId, maxLen) {
	if (modelId.length <= maxLen) return modelId;
	return `…${modelId.slice(-(maxLen - 1))}`;
}
/**
* Get page size for model list pagination.
*/
function getModelsPageSize() {
	return MODELS_PAGE_SIZE;
}
/**
* Calculate total pages for a model list.
*/
function calculateTotalPages(totalModels, pageSize) {
	const size = pageSize ?? MODELS_PAGE_SIZE;
	return size > 0 ? Math.ceil(totalModels / size) : 1;
}
//#endregion
//#region extensions/telegram/src/command-ui.ts
function buildCommandsPaginationKeyboard(currentPage, totalPages, agentId) {
	const buttons = [];
	const suffix = agentId ? `:${agentId}` : "";
	if (currentPage > 1) buttons.push({
		text: "◀ Prev",
		callback_data: `commands_page_${currentPage - 1}${suffix}`
	});
	buttons.push({
		text: `${currentPage}/${totalPages}`,
		callback_data: `commands_page_noop${suffix}`
	});
	if (currentPage < totalPages) buttons.push({
		text: "Next ▶",
		callback_data: `commands_page_${currentPage + 1}${suffix}`
	});
	return [buttons];
}
function buildTelegramModelsMenuButtons(params) {
	return buildProviderKeyboard(params.providers);
}
function buildTelegramModelsMenuChannelData(params) {
	if (params.providers.length === 0) return null;
	return { telegram: { buttons: buildTelegramModelsMenuButtons(params) } };
}
function buildTelegramCommandsListChannelData(params) {
	if (params.totalPages <= 1) return null;
	return { telegram: { buttons: buildCommandsPaginationKeyboard(params.currentPage, params.totalPages, params.agentId) } };
}
function buildTelegramModelsProviderChannelData(params) {
	if (params.providers.length === 0) return null;
	return { telegram: { buttons: buildProviderKeyboard(params.providers) } };
}
function buildTelegramModelsAddProviderChannelData(params) {
	if (params.providers.length === 0) return null;
	return { telegram: { buttons: params.providers.map((provider) => [{
		text: provider.id,
		callback_data: `/models add ${provider.id}`
	}]) } };
}
function buildTelegramModelsListChannelData(params) {
	return { telegram: { buttons: buildModelsKeyboard(params) } };
}
function buildTelegramModelBrowseChannelData() {
	return { telegram: { buttons: buildBrowseProvidersButton() } };
}
//#endregion
export { buildTelegramModelsListChannelData as a, buildTelegramModelsProviderChannelData as c, buildModelsKeyboard as d, buildProviderKeyboard as f, resolveModelSelection as g, parseModelCallbackData as h, buildTelegramModelsAddProviderChannelData as i, buildBrowseProvidersButton as l, getModelsPageSize as m, buildTelegramCommandsListChannelData as n, buildTelegramModelsMenuButtons as o, calculateTotalPages as p, buildTelegramModelBrowseChannelData as r, buildTelegramModelsMenuChannelData as s, buildCommandsPaginationKeyboard as t, buildModelSelectionCallbackData as u };
