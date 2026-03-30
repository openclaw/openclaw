import type {
	ModelDefinitionConfig,
	ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
	MINIMAX_TEXT_MODEL_CATALOG,
	MINIMAX_TEXT_MODEL_ORDER,
} from "./provider-models.js";

const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 204800;
const MINIMAX_DEFAULT_MAX_TOKENS = 131072;
const MINIMAX_API_COST = {
	input: 0.3,
	output: 1.2,
	cacheRead: 0.06,
	cacheWrite: 0.375,
};

function buildMinimaxModel(params: {
	id: string;
	name: string;
	reasoning: boolean;
	input: ModelDefinitionConfig["input"];
}): ModelDefinitionConfig {
	return {
		id: params.id,
		name: params.name,
		reasoning: params.reasoning,
		input: params.input,
		cost: MINIMAX_API_COST,
		contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
		maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
	};
}

function buildMinimaxTextModel(params: {
	id: string;
	name: string;
	reasoning: boolean;
}): ModelDefinitionConfig {
	return buildMinimaxModel({ ...params, input: ["text"] });
}

function buildMinimaxCatalog(): ModelDefinitionConfig[] {
	return MINIMAX_TEXT_MODEL_ORDER.map((id) => {
		const model = MINIMAX_TEXT_MODEL_CATALOG[id];
		return buildMinimaxTextModel({
			id,
			name: model.name,
			reasoning: model.reasoning,
		});
	});
}

export function buildMinimaxProvider(): ModelProviderConfig {
	return {
		baseUrl: MINIMAX_PORTAL_BASE_URL,
		api: "anthropic-messages",
		authHeader: true,
		models: buildMinimaxCatalog(),
	};
}

export function buildMinimaxPortalProvider(): ModelProviderConfig {
	return {
		baseUrl: MINIMAX_PORTAL_BASE_URL,
		api: "anthropic-messages",
		authHeader: true,
		models: buildMinimaxCatalog(),
	};
}
