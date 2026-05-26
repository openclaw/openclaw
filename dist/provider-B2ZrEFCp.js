import { _ as resolveFoundryModelCapabilities, d as isFoundryProviderApi, i as PROVIDER_ID, l as buildFoundryProviderBaseUrl, o as applyFoundryProfileBinding, p as normalizeFoundryEndpoint, s as applyFoundryProviderConfig, u as extractFoundryEndpoint, v as resolveFoundryTargetProfileId } from "./shared-BspuLN8V.js";
import { n as entraIdAuthMethod, t as apiKeyAuthMethod } from "./auth-aatOWW4D.js";
import { t as prepareFoundryRuntimeAuth } from "./runtime-C4ePYTbO.js";
//#region extensions/microsoft-foundry/provider.ts
function buildMicrosoftFoundryProvider() {
	return {
		id: PROVIDER_ID,
		label: "Microsoft Foundry",
		docsPath: "/providers/models",
		envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
		auth: [entraIdAuthMethod, apiKeyAuthMethod],
		onModelSelected: async (ctx) => {
			const providerConfig = ctx.config.models?.providers?.[PROVIDER_ID];
			if (!providerConfig || !providerConfig.baseUrl?.trim() || !Array.isArray(providerConfig.models) || !ctx.model.startsWith(`microsoft-foundry/`)) return;
			const selectedModelId = ctx.model.slice(`${PROVIDER_ID}/`.length);
			const configuredModels = providerConfig.models ?? [];
			const existingModel = configuredModels.find((model) => model.id === selectedModelId);
			const selectedModelCapabilities = resolveFoundryModelCapabilities(selectedModelId, existingModel?.name, isFoundryProviderApi(existingModel?.api) ? existingModel.api : providerConfig.api, existingModel?.input);
			const providerEndpoint = normalizeFoundryEndpoint(providerConfig.baseUrl ?? "");
			const selectedModelApi = isFoundryProviderApi(existingModel?.api) ? existingModel.api : providerConfig.api;
			const nextModels = configuredModels.map((model) => {
				if (model.id !== selectedModelId) return model;
				const nextModel = Object.assign({}, model, {
					name: selectedModelCapabilities.modelName,
					api: selectedModelCapabilities.api,
					input: selectedModelCapabilities.input
				});
				if (selectedModelCapabilities.compat) nextModel.compat = selectedModelCapabilities.compat;
				return nextModel;
			});
			if (!nextModels.some((model) => model.id === selectedModelId)) nextModels.push({
				id: selectedModelId,
				name: selectedModelCapabilities.modelName,
				api: selectedModelCapabilities.api,
				reasoning: false,
				input: selectedModelCapabilities.input,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0
				},
				contextWindow: 128e3,
				maxTokens: 16384,
				...selectedModelCapabilities.compat ? { compat: selectedModelCapabilities.compat } : {}
			});
			const nextProviderConfig = {
				...providerConfig,
				baseUrl: buildFoundryProviderBaseUrl(providerEndpoint, selectedModelId, selectedModelCapabilities.modelName, selectedModelApi),
				api: selectedModelCapabilities.api,
				models: nextModels
			};
			const targetProfileId = resolveFoundryTargetProfileId(ctx.config);
			if (targetProfileId) applyFoundryProfileBinding(ctx.config, targetProfileId);
			applyFoundryProviderConfig(ctx.config, nextProviderConfig);
		},
		normalizeResolvedModel: ({ modelId, model }) => {
			const endpoint = extractFoundryEndpoint(model.baseUrl ?? "");
			if (!endpoint) return model;
			const capabilities = resolveFoundryModelCapabilities(modelId, model.name, isFoundryProviderApi(model.api) ? model.api : void 0, model.input);
			return {
				...model,
				name: capabilities.modelName,
				api: capabilities.api,
				input: capabilities.input,
				baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId, capabilities.modelName, capabilities.api),
				...capabilities.compat ? { compat: capabilities.compat } : {}
			};
		},
		prepareRuntimeAuth: prepareFoundryRuntimeAuth
	};
}
//#endregion
export { buildMicrosoftFoundryProvider as t };
