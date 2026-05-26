import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isSecretRef } from "./types.secrets-DwPik3M8.js";
import { r as DEFAULT_PROVIDER } from "./defaults-mDjiWzE5.js";
import { i as buildModelAliasIndex } from "./model-selection-shared-ClxdEp4X.js";
import { n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import "./model-selection-P-81eBKx.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-CsdRhsMj.js";
import "./context-window-guard-BAul1ZXt.js";
import { t as normalizeAlias } from "./alias-name-dY2or4SK.js";
import { t as applyPrimaryModel } from "./provider-model-primary-Df1toqCt.js";
//#region src/commands/onboard-custom-config.ts
/**
* Wizard default for non-Azure custom APIs when context length is unknown.
* Mirrors the generic persisted custom-model catalog fallback and leaves enough
* room above the default compaction reserve floor in `pi-settings.ts`.
*/
const CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS = 128e3;
const DEFAULT_CONTEXT_WINDOW = CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS;
const DEFAULT_MAX_TOKENS = 4096;
const AZURE_DEFAULT_CONTEXT_WINDOW = 4e5;
const AZURE_DEFAULT_MAX_TOKENS = 16384;
function normalizeContextWindowForCustomModel(value) {
	const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
	if (parsed <= 0 || parsed === 4e3) return CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS;
	return parsed >= 4e3 ? parsed : CUSTOM_PROVIDER_DEFAULT_CONTEXT_WINDOW_TOKENS;
}
function customModelInputs(supportsImageInput) {
	return supportsImageInput ? ["text", "image"] : ["text"];
}
function resolveCustomModelImageInputInference(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	if (!normalized) return {
		supportsImageInput: false,
		confidence: "unknown"
	};
	if (/\b(?:gpt-4o|gpt-4\.1|gpt-[5-9]|o[134])\b/.test(normalized) || /\bclaude-(?:3|4|sonnet|opus|haiku)\b/.test(normalized) || /\bgemini\b/.test(normalized) || /\b(?:qwen[\w.-]*-?vl|qwen-vl)\b/.test(normalized) || /\b(?:vision|llava|pixtral|internvl|mllama|minicpm-v|glm-4v)\b/.test(normalized) || /(?:^|[-_/])vl(?:[-_/]|$)/.test(normalized)) return {
		supportsImageInput: true,
		confidence: "known"
	};
	if (/\b(?:llama\d*|deepseek|mistral|mixtral|kimi|moonshot|codestral|devstral|phi|qwq|codellama)\b/.test(normalized) || /\bqwen(?!.*(?:vl|vision))/.test(normalized)) return {
		supportsImageInput: false,
		confidence: "known"
	};
	return {
		supportsImageInput: false,
		confidence: "unknown"
	};
}
function resolveCustomModelSupportsImageInput(params) {
	return params.explicit ?? (() => {
		if (!params.inferKnownModels) return params.fallback;
		const inference = resolveCustomModelImageInputInference(params.modelId);
		return inference.confidence === "known" ? inference.supportsImageInput : params.fallback;
	})();
}
function isAzureFoundryUrl(baseUrl) {
	try {
		return normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname).endsWith(".services.ai.azure.com");
	} catch {
		return false;
	}
}
function isAzureOpenAiUrl(baseUrl) {
	try {
		return normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname).endsWith(".openai.azure.com");
	} catch {
		return false;
	}
}
function isAzureUrl(baseUrl) {
	return isAzureFoundryUrl(baseUrl) || isAzureOpenAiUrl(baseUrl);
}
/**
* Transforms an Azure AI Foundry/OpenAI URL to include the deployment path.
* Azure requires: https://host/openai/deployments/<model-id>/chat/completions?api-version=2024-xx-xx-preview
* But we can't add query params here, so we just add the path prefix.
* The api-version will be handled by the Azure OpenAI client or as a query param.
*
* Example:
*   https://my-resource.services.ai.azure.com + gpt-5.4-nano
*   => https://my-resource.services.ai.azure.com/openai/deployments/gpt-5.4-nano
*/
function transformAzureUrl(baseUrl, modelId) {
	const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	if (normalizedUrl.includes("/openai/deployments/")) return normalizedUrl;
	return `${normalizedUrl}/openai/deployments/${modelId}`;
}
/**
* Transforms an Azure URL into the base URL stored in config.
*
* Example:
*   https://my-resource.openai.azure.com
*   => https://my-resource.openai.azure.com/openai/v1
*/
function transformAzureConfigUrl(baseUrl) {
	const normalizedUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	if (normalizedUrl.endsWith("/openai/v1")) return normalizedUrl;
	const deploymentIdx = normalizedUrl.indexOf("/openai/deployments/");
	return `${deploymentIdx !== -1 ? normalizedUrl.slice(0, deploymentIdx) : normalizedUrl}/openai/v1`;
}
function hasSameHost(a, b) {
	try {
		return normalizeLowercaseStringOrEmpty(new URL(a).hostname) === normalizeLowercaseStringOrEmpty(new URL(b).hostname);
	} catch {
		return false;
	}
}
var CustomApiError = class extends Error {
	constructor(code, message) {
		super(message);
		this.name = "CustomApiError";
		this.code = code;
	}
};
function normalizeEndpointId(raw) {
	const trimmed = normalizeOptionalLowercaseString(raw);
	if (!trimmed) return "";
	return trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}
function buildEndpointIdFromUrl(baseUrl) {
	try {
		const url = new URL(baseUrl);
		return normalizeEndpointId(`custom-${normalizeLowercaseStringOrEmpty(url.hostname.replace(/[^a-z0-9]+/gi, "-"))}${url.port ? `-${url.port}` : ""}`) || "custom";
	} catch {
		return "custom";
	}
}
function resolveUniqueEndpointId(params) {
	const normalized = normalizeEndpointId(params.requestedId) || "custom";
	const existing = params.providers[normalized];
	if (!existing?.baseUrl || existing.baseUrl === params.baseUrl || isAzureUrl(params.baseUrl) && hasSameHost(existing.baseUrl, params.baseUrl)) return {
		providerId: normalized,
		renamed: false
	};
	let suffix = 2;
	let candidate = `${normalized}-${suffix}`;
	while (params.providers[candidate]) {
		suffix += 1;
		candidate = `${normalized}-${suffix}`;
	}
	return {
		providerId: candidate,
		renamed: true
	};
}
function resolveCustomModelAliasError(params) {
	const trimmed = params.raw.trim();
	if (!trimmed) return;
	let normalized;
	try {
		normalized = normalizeAlias(trimmed);
	} catch (err) {
		return err instanceof Error ? err.message : "Alias is invalid.";
	}
	const aliasIndex = buildModelAliasIndex({
		cfg: params.cfg,
		defaultProvider: DEFAULT_PROVIDER
	});
	const aliasKey = normalizeLowercaseStringOrEmpty(normalized);
	const existing = aliasIndex.byAlias.get(aliasKey);
	if (!existing) return;
	const existingKey = modelKey(existing.ref.provider, existing.ref.model);
	if (existingKey === params.modelRef) return;
	return `Alias ${normalized} already points to ${existingKey}.`;
}
function buildAzureOpenAiHeaders(apiKey) {
	const headers = {};
	if (apiKey) headers["api-key"] = apiKey;
	return headers;
}
function buildOpenAiHeaders(apiKey) {
	const headers = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}
function buildAnthropicHeaders(apiKey) {
	const headers = { "anthropic-version": "2023-06-01" };
	if (apiKey) headers["x-api-key"] = apiKey;
	return headers;
}
function normalizeOptionalProviderApiKey(value) {
	if (isSecretRef(value)) return value;
	return normalizeOptionalSecretInput(value);
}
function resolveVerificationEndpoint(params) {
	const resolvedUrl = isAzureUrl(params.baseUrl) ? transformAzureUrl(params.baseUrl, params.modelId) : params.baseUrl;
	const endpointUrl = new URL(params.endpointPath, resolvedUrl.endsWith("/") ? resolvedUrl : `${resolvedUrl}/`);
	if (isAzureUrl(params.baseUrl)) endpointUrl.searchParams.set("api-version", "2024-10-21");
	return endpointUrl.href;
}
function buildOpenAiVerificationProbeRequest(params) {
	const headers = isAzureUrl(params.baseUrl) ? buildAzureOpenAiHeaders(params.apiKey) : buildOpenAiHeaders(params.apiKey);
	if (isAzureOpenAiUrl(params.baseUrl)) return {
		endpoint: new URL("responses", transformAzureConfigUrl(params.baseUrl).replace(/\/?$/, "/")).href,
		headers,
		body: {
			model: params.modelId,
			input: "Hi",
			max_output_tokens: 16,
			stream: false
		}
	};
	return {
		endpoint: resolveVerificationEndpoint({
			baseUrl: params.baseUrl,
			modelId: params.modelId,
			endpointPath: "chat/completions"
		}),
		headers,
		body: {
			model: params.modelId,
			messages: [{
				role: "user",
				content: "Hi"
			}],
			max_tokens: 16,
			stream: false
		}
	};
}
function buildAnthropicVerificationProbeRequest(params) {
	return {
		endpoint: resolveVerificationEndpoint({
			baseUrl: /\/v1\/?$/.test(params.baseUrl.trim()) ? params.baseUrl.trim() : params.baseUrl.trim().replace(/\/?$/, "") + "/v1",
			modelId: params.modelId,
			endpointPath: "messages"
		}),
		headers: buildAnthropicHeaders(params.apiKey),
		body: {
			model: params.modelId,
			max_tokens: 1,
			messages: [{
				role: "user",
				content: "Hi"
			}],
			stream: false
		}
	};
}
function resolveProviderApi(compatibility) {
	return compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";
}
function parseCustomApiCompatibility(raw) {
	const compatibilityRaw = normalizeOptionalLowercaseString(raw);
	if (!compatibilityRaw) return "openai";
	if (compatibilityRaw !== "openai" && compatibilityRaw !== "anthropic") throw new CustomApiError("invalid_compatibility", "Invalid --custom-compatibility (use \"openai\" or \"anthropic\").");
	return compatibilityRaw;
}
function resolveCustomProviderId(params) {
	const providers = params.config.models?.providers ?? {};
	const baseUrl = params.baseUrl.trim();
	const explicitProviderId = params.providerId?.trim();
	if (explicitProviderId && !normalizeEndpointId(explicitProviderId)) throw new CustomApiError("invalid_provider_id", "Custom provider ID must include letters, numbers, or hyphens.");
	const requestedProviderId = explicitProviderId || buildEndpointIdFromUrl(baseUrl);
	const providerIdResult = resolveUniqueEndpointId({
		requestedId: requestedProviderId,
		baseUrl,
		providers
	});
	return {
		providerId: providerIdResult.providerId,
		...providerIdResult.renamed ? { providerIdRenamedFrom: normalizeEndpointId(requestedProviderId) || "custom" } : {}
	};
}
function parseNonInteractiveCustomApiFlags(params) {
	const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
	const modelId = normalizeOptionalString(params.modelId) ?? "";
	if (!baseUrl || !modelId) throw new CustomApiError("missing_required", ["Auth choice \"custom-api-key\" requires a base URL and model ID.", "Use --custom-base-url and --custom-model-id."].join("\n"));
	const apiKey = normalizeOptionalString(params.apiKey);
	const providerId = normalizeOptionalString(params.providerId);
	if (providerId && !normalizeEndpointId(providerId)) throw new CustomApiError("invalid_provider_id", "Custom provider ID must include letters, numbers, or hyphens.");
	return {
		baseUrl,
		modelId,
		compatibility: parseCustomApiCompatibility(params.compatibility),
		...apiKey ? { apiKey } : {},
		...providerId ? { providerId } : {},
		...params.supportsImageInput === void 0 ? {} : { supportsImageInput: params.supportsImageInput }
	};
}
function applyCustomApiConfig(params) {
	const baseUrl = normalizeOptionalString(params.baseUrl) ?? "";
	if (!URL.canParse(baseUrl)) throw new CustomApiError("invalid_base_url", "Custom provider base URL must be a valid URL.");
	if (params.compatibility !== "openai" && params.compatibility !== "anthropic") throw new CustomApiError("invalid_compatibility", "Custom provider compatibility must be \"openai\" or \"anthropic\".");
	const modelId = normalizeOptionalString(params.modelId) ?? "";
	if (!modelId) throw new CustomApiError("invalid_model_id", "Custom provider model ID is required.");
	const isAzure = isAzureUrl(baseUrl);
	const isAzureOpenAi = isAzureOpenAiUrl(baseUrl);
	const resolvedBaseUrl = isAzure ? transformAzureConfigUrl(baseUrl) : baseUrl;
	const providerIdResult = resolveCustomProviderId({
		config: params.config,
		baseUrl: resolvedBaseUrl,
		providerId: params.providerId
	});
	const providerId = providerIdResult.providerId;
	const providers = params.config.models?.providers ?? {};
	const modelRef = modelKey(providerId, modelId);
	const alias = normalizeOptionalString(params.alias) ?? "";
	const aliasError = resolveCustomModelAliasError({
		raw: alias,
		cfg: params.config,
		modelRef
	});
	if (aliasError) throw new CustomApiError("invalid_alias", aliasError);
	const existingProvider = providers[providerId];
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const hasModel = existingModels.some((model) => model.id === modelId);
	const isLikelyReasoningModel = isAzure && /\b(o[134]|gpt-([5-9]|\d{2,}))\b/i.test(modelId);
	const explicitInput = params.supportsImageInput === void 0 ? void 0 : customModelInputs(params.supportsImageInput);
	const generatedInput = customModelInputs(resolveCustomModelSupportsImageInput({
		modelId,
		explicit: params.supportsImageInput,
		fallback: isAzure && isLikelyReasoningModel,
		inferKnownModels: !isAzure
	}));
	const nextModel = isAzure ? {
		id: modelId,
		name: `${modelId} (Custom Provider)`,
		contextWindow: AZURE_DEFAULT_CONTEXT_WINDOW,
		maxTokens: AZURE_DEFAULT_MAX_TOKENS,
		input: generatedInput,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		reasoning: isLikelyReasoningModel,
		compat: { supportsStore: false }
	} : {
		id: modelId,
		name: `${modelId} (Custom Provider)`,
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		input: generatedInput,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		reasoning: false
	};
	const mergedModels = hasModel ? existingModels.map((model) => model.id === modelId ? {
		...model,
		...isAzure ? nextModel : {},
		...explicitInput ? { input: explicitInput } : {},
		name: model.name ?? nextModel.name,
		cost: model.cost ?? nextModel.cost,
		contextWindow: normalizeContextWindowForCustomModel(model.contextWindow),
		maxTokens: model.maxTokens ?? nextModel.maxTokens
	} : model) : [...existingModels, nextModel];
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = normalizeOptionalProviderApiKey(params.apiKey) ?? normalizeOptionalProviderApiKey(existingApiKey);
	const providerApi = isAzureOpenAi ? "azure-openai-responses" : resolveProviderApi(params.compatibility);
	const azureHeaders = isAzure && normalizedApiKey ? { "api-key": normalizedApiKey } : void 0;
	let config = {
		...params.config,
		models: {
			...params.config.models,
			mode: params.config.models?.mode ?? "merge",
			providers: {
				...providers,
				[providerId]: {
					...existingProviderRest,
					baseUrl: resolvedBaseUrl,
					api: providerApi,
					...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
					...isAzure ? { authHeader: false } : {},
					...azureHeaders ? { headers: azureHeaders } : {},
					models: mergedModels.length > 0 ? mergedModels : [nextModel]
				}
			}
		}
	};
	config = applyPrimaryModel(config, modelRef);
	if (isAzure && isLikelyReasoningModel) {
		if (!config.agents?.defaults?.models?.[modelRef]?.params?.thinking) config = {
			...config,
			agents: {
				...config.agents,
				defaults: {
					...config.agents?.defaults,
					models: {
						...config.agents?.defaults?.models,
						[modelRef]: {
							...config.agents?.defaults?.models?.[modelRef],
							params: {
								...config.agents?.defaults?.models?.[modelRef]?.params,
								thinking: "medium"
							}
						}
					}
				}
			}
		};
	}
	if (alias) config = {
		...config,
		agents: {
			...config.agents,
			defaults: {
				...config.agents?.defaults,
				models: {
					...config.agents?.defaults?.models,
					[modelRef]: {
						...config.agents?.defaults?.models?.[modelRef],
						alias
					}
				}
			}
		}
	};
	return {
		config,
		providerId,
		modelId,
		...providerIdResult.providerIdRenamedFrom ? { providerIdRenamedFrom: providerIdResult.providerIdRenamedFrom } : {}
	};
}
//#endregion
export { buildOpenAiVerificationProbeRequest as a, parseNonInteractiveCustomApiFlags as c, resolveCustomProviderId as d, buildEndpointIdFromUrl as i, resolveCustomModelAliasError as l, applyCustomApiConfig as n, normalizeEndpointId as o, buildAnthropicVerificationProbeRequest as r, normalizeOptionalProviderApiKey as s, CustomApiError as t, resolveCustomModelImageInputInference as u };
