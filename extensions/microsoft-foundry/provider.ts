import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/core";
import type {
	ModelProviderConfig,
	ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { apiKeyAuthMethod, entraIdAuthMethod } from "./auth.js";
import { prepareFoundryRuntimeAuth } from "./runtime.js";
import {
	applyFoundryProfileBinding,
	applyFoundryProviderConfig,
	buildFoundryModelCompat,
	buildFoundryProviderBaseUrl,
	extractFoundryEndpoint,
	isFoundryProviderApi,
	normalizeFoundryEndpoint,
	PROVIDER_ID,
	resolveConfiguredModelNameHint,
	resolveFoundryApi,
	resolveFoundryTargetProfileId,
} from "./shared.js";

export function buildMicrosoftFoundryProvider(): ProviderPlugin {
	return {
		id: PROVIDER_ID,
		label: "Microsoft Foundry",
		docsPath: "/providers/models",
		envVars: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
		auth: [entraIdAuthMethod, apiKeyAuthMethod],
		capabilities: {
			providerFamily: "openai" as const,
		},
		onModelSelected: async (ctx) => {
			const providerConfig = ctx.config.models?.providers?.[PROVIDER_ID];
			if (!providerConfig || !ctx.model.startsWith(`${PROVIDER_ID}/`)) {
				return;
			}
			const selectedModelId = ctx.model.slice(`${PROVIDER_ID}/`.length);
			const existingModel = providerConfig.models.find(
				(model: { id: string }) => model.id === selectedModelId,
			);
			const selectedModelNameHint = resolveConfiguredModelNameHint(
				selectedModelId,
				existingModel?.name,
			);
			const providerEndpoint = normalizeFoundryEndpoint(
				providerConfig.baseUrl ?? "",
			);
			// Prefer the persisted per-model API choice from onboarding/discovery so arbitrary
			// deployment aliases (for example prod-primary) do not fall back to name heuristics.
			const selectedModelApi = isFoundryProviderApi(existingModel?.api)
				? existingModel.api
				: providerConfig.api;
			const selectedModelCompat = buildFoundryModelCompat(
				selectedModelId,
				selectedModelNameHint,
				selectedModelApi,
			);
			const nextModels = providerConfig.models.map((model) =>
				model.id === selectedModelId
					? {
							...model,
							api: resolveFoundryApi(
								selectedModelId,
								selectedModelNameHint,
								selectedModelApi,
							),
							...(selectedModelCompat ? { compat: selectedModelCompat } : {}),
						}
					: model,
			);
			if (!nextModels.some((model) => model.id === selectedModelId)) {
				nextModels.push({
					id: selectedModelId,
					name: selectedModelNameHint ?? selectedModelId,
					api: resolveFoundryApi(
						selectedModelId,
						selectedModelNameHint,
						selectedModelApi,
					),
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
					...(selectedModelCompat ? { compat: selectedModelCompat } : {}),
				});
			}
			const nextProviderConfig: ModelProviderConfig = {
				...providerConfig,
				baseUrl: buildFoundryProviderBaseUrl(
					providerEndpoint,
					selectedModelId,
					selectedModelNameHint,
					selectedModelApi,
				),
				api: resolveFoundryApi(
					selectedModelId,
					selectedModelNameHint,
					selectedModelApi,
				),
				models: nextModels,
			};
			const targetProfileId = resolveFoundryTargetProfileId(ctx.config);
			if (targetProfileId) {
				applyFoundryProfileBinding(ctx.config, targetProfileId);
			}
			applyFoundryProviderConfig(ctx.config, nextProviderConfig);
		},
		normalizeResolvedModel: ({
			modelId,
			model,
		}: ProviderNormalizeResolvedModelContext) => {
			const endpoint = extractFoundryEndpoint(String(model.baseUrl ?? ""));
			if (!endpoint) {
				return model;
			}
			const modelNameHint = resolveConfiguredModelNameHint(modelId, model.name);
			const configuredApi = isFoundryProviderApi(model.api)
				? model.api
				: undefined;
			const compat = buildFoundryModelCompat(
				modelId,
				modelNameHint,
				configuredApi,
			);
			return {
				...model,
				api: resolveFoundryApi(modelId, modelNameHint, configuredApi),
				baseUrl: buildFoundryProviderBaseUrl(
					endpoint,
					modelId,
					modelNameHint,
					configuredApi,
				),
				...(compat ? { compat } : {}),
			};
		},
		prepareRuntimeAuth: prepareFoundryRuntimeAuth,
	};
}
