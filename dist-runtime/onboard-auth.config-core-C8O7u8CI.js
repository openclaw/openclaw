import { n as PROVIDER_ENV_VARS } from "./provider-env-vars-BfZUtZAn.js";
import { a as init_types_secrets, r as coerceSecretRef, t as DEFAULT_SECRET_PROVIDER_ALIAS } from "./types.secrets-Br5ssFsN.js";
import { r as init_paths } from "./paths-CbmqEZIn.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CZ08wtw1.js";
import { a as KILOCODE_DEFAULT_MODEL_REF, t as KILOCODE_BASE_URL } from "./kilocode-shared-Ci8SRxXc.js";
import { C as buildTogetherModelDefinition, D as buildSyntheticModelDefinition, E as SYNTHETIC_MODEL_CATALOG, S as TOGETHER_MODEL_CATALOG, T as SYNTHETIC_DEFAULT_MODEL_REF, _ as buildQianfanProvider, b as buildXiaomiProvider, c as buildKilocodeProvider, l as buildKimiCodingProvider, n as QIANFAN_DEFAULT_MODEL_ID, r as XIAOMI_DEFAULT_MODEL_ID, w as SYNTHETIC_BASE_URL, x as TOGETHER_BASE_URL } from "./models-config.providers.static-DRBnLpDj.js";
import { _ as buildHuggingfaceModelDefinition, c as VENICE_BASE_URL, d as buildVeniceModelDefinition, g as HUGGINGFACE_MODEL_CATALOG, h as HUGGINGFACE_BASE_URL, l as VENICE_DEFAULT_MODEL_REF, u as VENICE_MODEL_CATALOG } from "./models-config.providers.discovery-gVOHvGnm.js";
import { A as resolveZaiBaseUrl, D as buildMoonshotModelDefinition, E as buildModelStudioModelDefinition, O as buildXaiModelDefinition, T as buildMistralModelDefinition, _ as XAI_DEFAULT_MODEL_ID, a as MISTRAL_BASE_URL, c as MODELSTUDIO_CN_BASE_URL, d as MOONSHOT_BASE_URL, f as MOONSHOT_CN_BASE_URL, g as XAI_BASE_URL, h as QIANFAN_DEFAULT_MODEL_REF, k as buildZaiModelDefinition, l as MODELSTUDIO_DEFAULT_MODEL_REF, m as MOONSHOT_DEFAULT_MODEL_REF, n as KIMI_CODING_MODEL_REF, o as MISTRAL_DEFAULT_MODEL_ID, p as MOONSHOT_DEFAULT_MODEL_ID, s as MISTRAL_DEFAULT_MODEL_REF, t as KIMI_CODING_MODEL_ID, u as MODELSTUDIO_GLOBAL_BASE_URL, v as XAI_DEFAULT_MODEL_REF } from "./onboard-auth.models-DU-07n1Q.js";
import { a as applyProviderConfigWithModelCatalog, i as applyProviderConfigWithDefaultModels, n as applyOnboardAuthAgentModelsAndProviders, r as applyProviderConfigWithDefaultModel, t as applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared-0Mir11tv.js";
import "node:fs";
import "node:path";
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF = `cloudflare-ai-gateway/claude-sonnet-4-5`;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW = 2e5;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS = 64e3;
const CLOUDFLARE_AI_GATEWAY_DEFAULT_COST = {
	input: 3,
	output: 15,
	cacheRead: .3,
	cacheWrite: 3.75
};
function buildCloudflareAiGatewayModelDefinition(params) {
	return {
		id: params?.id?.trim() || "claude-sonnet-4-5",
		name: params?.name ?? "Claude Sonnet 4.5",
		reasoning: params?.reasoning ?? true,
		input: params?.input ?? ["text", "image"],
		cost: CLOUDFLARE_AI_GATEWAY_DEFAULT_COST,
		contextWindow: CLOUDFLARE_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
		maxTokens: CLOUDFLARE_AI_GATEWAY_DEFAULT_MAX_TOKENS
	};
}
function resolveCloudflareAiGatewayBaseUrl(params) {
	const accountId = params.accountId.trim();
	const gatewayId = params.gatewayId.trim();
	if (!accountId || !gatewayId) return "";
	return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;
}
//#endregion
//#region src/commands/onboard-auth.credentials.ts
init_paths();
init_types_secrets();
const ENV_REF_PATTERN = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
function buildEnvSecretRef(id) {
	return {
		source: "env",
		provider: DEFAULT_SECRET_PROVIDER_ALIAS,
		id
	};
}
function parseEnvSecretRef(value) {
	const match = ENV_REF_PATTERN.exec(value);
	if (!match) return null;
	return buildEnvSecretRef(match[1]);
}
function resolveProviderDefaultEnvSecretRef(provider) {
	const envVar = PROVIDER_ENV_VARS[provider]?.find((candidate) => candidate.trim().length > 0);
	if (!envVar) throw new Error(`Provider "${provider}" does not have a default env var mapping for secret-input-mode=ref.`);
	return buildEnvSecretRef(envVar);
}
function resolveApiKeySecretInput(provider, input, options) {
	const coercedRef = coerceSecretRef(input);
	if (coercedRef) return coercedRef;
	const normalized = normalizeSecretInput(input);
	const inlineEnvRef = parseEnvSecretRef(normalized);
	if (inlineEnvRef) return inlineEnvRef;
	if (options?.secretInputMode === "ref") return resolveProviderDefaultEnvSecretRef(provider);
	return normalized;
}
function buildApiKeyCredential(provider, input, metadata, options) {
	const secretInput = resolveApiKeySecretInput(provider, input, options);
	if (typeof secretInput === "string") return {
		type: "api_key",
		provider,
		key: secretInput,
		...metadata ? { metadata } : {}
	};
	return {
		type: "api_key",
		provider,
		keyRef: secretInput,
		...metadata ? { metadata } : {}
	};
}
const ZAI_DEFAULT_MODEL_REF = "zai/glm-5";
const XIAOMI_DEFAULT_MODEL_REF = "xiaomi/mimo-v2-flash";
const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";
const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";
//#endregion
//#region src/commands/onboard-auth.config-gateways.ts
function applyVercelAiGatewayProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF] = {
		...models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF],
		alias: models["vercel-ai-gateway/anthropic/claude-opus-4.6"]?.alias ?? "Vercel AI Gateway"
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
}
function applyCloudflareAiGatewayProviderConfig(cfg, params) {
	const models = { ...cfg.agents?.defaults?.models };
	models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF] = {
		...models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF],
		alias: models[CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Cloudflare AI Gateway"
	};
	const defaultModel = buildCloudflareAiGatewayModelDefinition();
	const existingProvider = cfg.models?.providers?.["cloudflare-ai-gateway"];
	const baseUrl = params?.accountId && params?.gatewayId ? resolveCloudflareAiGatewayBaseUrl({
		accountId: params.accountId,
		gatewayId: params.gatewayId
	}) : typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl : void 0;
	if (!baseUrl) return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "cloudflare-ai-gateway",
		api: "anthropic-messages",
		baseUrl,
		defaultModel
	});
}
function applyVercelAiGatewayConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyVercelAiGatewayProviderConfig(cfg), VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF);
}
function applyCloudflareAiGatewayConfig(cfg, params) {
	return applyAgentDefaultModelPrimary(applyCloudflareAiGatewayProviderConfig(cfg, params), CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF);
}
//#endregion
//#region src/commands/onboard-auth.config-core.ts
function mergeProviderModels(existingProvider, defaultModels) {
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const mergedModels = [...existingModels];
	const seen = new Set(existingModels.map((model) => model.id));
	for (const model of defaultModels) if (!seen.has(model.id)) {
		mergedModels.push(model);
		seen.add(model.id);
	}
	return mergedModels;
}
function getNormalizedProviderApiKey(existingProvider) {
	const { apiKey } = existingProvider ?? {};
	return typeof apiKey === "string" ? apiKey.trim() || void 0 : void 0;
}
function applyZaiProviderConfig(cfg, params) {
	const modelRef = `zai/${params?.modelId?.trim() || "glm-5"}`;
	const models = { ...cfg.agents?.defaults?.models };
	models[modelRef] = {
		...models[modelRef],
		alias: models[modelRef]?.alias ?? "GLM"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.zai;
	const defaultModels = [
		buildZaiModelDefinition({ id: "glm-5" }),
		buildZaiModelDefinition({ id: "glm-5-turbo" }),
		buildZaiModelDefinition({ id: "glm-4.7" }),
		buildZaiModelDefinition({ id: "glm-4.7-flash" }),
		buildZaiModelDefinition({ id: "glm-4.7-flashx" })
	];
	const mergedModels = mergeProviderModels(existingProvider, defaultModels);
	const { apiKey: _existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = getNormalizedProviderApiKey(existingProvider);
	const baseUrl = params?.endpoint ? resolveZaiBaseUrl(params.endpoint) : (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl : "") || resolveZaiBaseUrl();
	providers.zai = {
		...existingProviderRest,
		baseUrl,
		api: "openai-completions",
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : defaultModels
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applyZaiConfig(cfg, params) {
	const modelId = params?.modelId?.trim() || "glm-5";
	const modelRef = modelId === "glm-5" ? ZAI_DEFAULT_MODEL_REF : `zai/${modelId}`;
	return applyAgentDefaultModelPrimary(applyZaiProviderConfig(cfg, params), modelRef);
}
function applyOpenrouterProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[OPENROUTER_DEFAULT_MODEL_REF] = {
		...models[OPENROUTER_DEFAULT_MODEL_REF],
		alias: models["openrouter/auto"]?.alias ?? "OpenRouter"
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		}
	};
}
function applyOpenrouterConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpenrouterProviderConfig(cfg), OPENROUTER_DEFAULT_MODEL_REF);
}
function applyMoonshotProviderConfig(cfg) {
	return applyMoonshotProviderConfigWithBaseUrl(cfg, MOONSHOT_BASE_URL);
}
function applyMoonshotProviderConfigCn(cfg) {
	return applyMoonshotProviderConfigWithBaseUrl(cfg, MOONSHOT_CN_BASE_URL);
}
function applyMoonshotProviderConfigWithBaseUrl(cfg, baseUrl) {
	const models = { ...cfg.agents?.defaults?.models };
	models[MOONSHOT_DEFAULT_MODEL_REF] = {
		...models[MOONSHOT_DEFAULT_MODEL_REF],
		alias: models[MOONSHOT_DEFAULT_MODEL_REF]?.alias ?? "Kimi"
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "moonshot",
		api: "openai-completions",
		baseUrl,
		defaultModel: buildMoonshotModelDefinition(),
		defaultModelId: MOONSHOT_DEFAULT_MODEL_ID
	});
}
function applyMoonshotConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyMoonshotProviderConfig(cfg), MOONSHOT_DEFAULT_MODEL_REF);
}
function applyMoonshotConfigCn(cfg) {
	return applyAgentDefaultModelPrimary(applyMoonshotProviderConfigCn(cfg), MOONSHOT_DEFAULT_MODEL_REF);
}
function applyKimiCodeProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[KIMI_CODING_MODEL_REF] = {
		...models[KIMI_CODING_MODEL_REF],
		alias: models[KIMI_CODING_MODEL_REF]?.alias ?? "Kimi for Coding"
	};
	const defaultModel = buildKimiCodingProvider().models[0];
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "kimi-coding",
		api: "anthropic-messages",
		baseUrl: "https://api.kimi.com/coding/",
		defaultModel,
		defaultModelId: KIMI_CODING_MODEL_ID
	});
}
function applyKimiCodeConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyKimiCodeProviderConfig(cfg), KIMI_CODING_MODEL_REF);
}
function applySyntheticProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[SYNTHETIC_DEFAULT_MODEL_REF] = {
		...models[SYNTHETIC_DEFAULT_MODEL_REF],
		alias: models[SYNTHETIC_DEFAULT_MODEL_REF]?.alias ?? "MiniMax M2.5"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.synthetic;
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const syntheticModels = SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition);
	const mergedModels = [...existingModels, ...syntheticModels.filter((model) => !existingModels.some((existing) => existing.id === model.id))];
	const { apiKey: _existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = getNormalizedProviderApiKey(existingProvider);
	providers.synthetic = {
		...existingProviderRest,
		baseUrl: SYNTHETIC_BASE_URL,
		api: "anthropic-messages",
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : syntheticModels
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applySyntheticConfig(cfg) {
	return applyAgentDefaultModelPrimary(applySyntheticProviderConfig(cfg), SYNTHETIC_DEFAULT_MODEL_REF);
}
function applyXiaomiProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[XIAOMI_DEFAULT_MODEL_REF] = {
		...models[XIAOMI_DEFAULT_MODEL_REF],
		alias: models["xiaomi/mimo-v2-flash"]?.alias ?? "Xiaomi"
	};
	const defaultProvider = buildXiaomiProvider();
	return applyProviderConfigWithDefaultModels(cfg, {
		agentModels: models,
		providerId: "xiaomi",
		api: defaultProvider.api ?? "openai-completions",
		baseUrl: defaultProvider.baseUrl,
		defaultModels: defaultProvider.models ?? [],
		defaultModelId: XIAOMI_DEFAULT_MODEL_ID
	});
}
function applyXiaomiConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyXiaomiProviderConfig(cfg), XIAOMI_DEFAULT_MODEL_REF);
}
/**
* Apply Venice provider configuration without changing the default model.
* Registers Venice models and sets up the provider, but preserves existing model selection.
*/
function applyVeniceProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[VENICE_DEFAULT_MODEL_REF] = {
		...models[VENICE_DEFAULT_MODEL_REF],
		alias: models[VENICE_DEFAULT_MODEL_REF]?.alias ?? "Kimi K2.5"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "venice",
		api: "openai-completions",
		baseUrl: VENICE_BASE_URL,
		catalogModels: VENICE_MODEL_CATALOG.map(buildVeniceModelDefinition)
	});
}
/**
* Apply Venice provider configuration AND set Venice as the default model.
* Use this when Venice is the primary provider choice during setup.
*/
function applyVeniceConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyVeniceProviderConfig(cfg), VENICE_DEFAULT_MODEL_REF);
}
/**
* Apply Together provider configuration without changing the default model.
* Registers Together models and sets up the provider, but preserves existing model selection.
*/
function applyTogetherProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[TOGETHER_DEFAULT_MODEL_REF] = {
		...models[TOGETHER_DEFAULT_MODEL_REF],
		alias: models["together/moonshotai/Kimi-K2.5"]?.alias ?? "Together AI"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "together",
		api: "openai-completions",
		baseUrl: TOGETHER_BASE_URL,
		catalogModels: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition)
	});
}
/**
* Apply Together provider configuration AND set Together as the default model.
* Use this when Together is the primary provider choice during setup.
*/
function applyTogetherConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyTogetherProviderConfig(cfg), TOGETHER_DEFAULT_MODEL_REF);
}
/**
* Apply Hugging Face (Inference Providers) provider configuration without changing the default model.
*/
function applyHuggingfaceProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[HUGGINGFACE_DEFAULT_MODEL_REF] = {
		...models[HUGGINGFACE_DEFAULT_MODEL_REF],
		alias: models["huggingface/deepseek-ai/DeepSeek-R1"]?.alias ?? "Hugging Face"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "huggingface",
		api: "openai-completions",
		baseUrl: HUGGINGFACE_BASE_URL,
		catalogModels: HUGGINGFACE_MODEL_CATALOG.map(buildHuggingfaceModelDefinition)
	});
}
/**
* Apply Hugging Face provider configuration AND set Hugging Face as the default model.
*/
function applyHuggingfaceConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyHuggingfaceProviderConfig(cfg), HUGGINGFACE_DEFAULT_MODEL_REF);
}
function applyXaiProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[XAI_DEFAULT_MODEL_REF] = {
		...models[XAI_DEFAULT_MODEL_REF],
		alias: models[XAI_DEFAULT_MODEL_REF]?.alias ?? "Grok"
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "xai",
		api: "openai-completions",
		baseUrl: XAI_BASE_URL,
		defaultModel: buildXaiModelDefinition(),
		defaultModelId: XAI_DEFAULT_MODEL_ID
	});
}
function applyXaiConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyXaiProviderConfig(cfg), XAI_DEFAULT_MODEL_REF);
}
function applyMistralProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[MISTRAL_DEFAULT_MODEL_REF] = {
		...models[MISTRAL_DEFAULT_MODEL_REF],
		alias: models[MISTRAL_DEFAULT_MODEL_REF]?.alias ?? "Mistral"
	};
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "mistral",
		api: "openai-completions",
		baseUrl: MISTRAL_BASE_URL,
		defaultModel: buildMistralModelDefinition(),
		defaultModelId: MISTRAL_DEFAULT_MODEL_ID
	});
}
function applyMistralConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyMistralProviderConfig(cfg), MISTRAL_DEFAULT_MODEL_REF);
}
/**
* Apply Kilo Gateway provider configuration without changing the default model.
* Registers Kilo Gateway and sets up the provider, but preserves existing model selection.
*/
function applyKilocodeProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[KILOCODE_DEFAULT_MODEL_REF] = {
		...models[KILOCODE_DEFAULT_MODEL_REF],
		alias: models[KILOCODE_DEFAULT_MODEL_REF]?.alias ?? "Kilo Gateway"
	};
	return applyProviderConfigWithModelCatalog(cfg, {
		agentModels: models,
		providerId: "kilocode",
		api: "openai-completions",
		baseUrl: KILOCODE_BASE_URL,
		catalogModels: buildKilocodeProvider().models ?? []
	});
}
/**
* Apply Kilo Gateway provider configuration AND set Kilo Gateway as the default model.
* Use this when Kilo Gateway is the primary provider choice during setup.
*/
function applyKilocodeConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyKilocodeProviderConfig(cfg), KILOCODE_DEFAULT_MODEL_REF);
}
function applyQianfanProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[QIANFAN_DEFAULT_MODEL_REF] = {
		...models[QIANFAN_DEFAULT_MODEL_REF],
		alias: models[QIANFAN_DEFAULT_MODEL_REF]?.alias ?? "QIANFAN"
	};
	const defaultProvider = buildQianfanProvider();
	const existingProvider = cfg.models?.providers?.qianfan;
	const resolvedBaseUrl = (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "") || "https://qianfan.baidubce.com/v2";
	return applyProviderConfigWithDefaultModels(cfg, {
		agentModels: models,
		providerId: "qianfan",
		api: typeof existingProvider?.api === "string" ? existingProvider.api : "openai-completions",
		baseUrl: resolvedBaseUrl,
		defaultModels: defaultProvider.models ?? [],
		defaultModelId: QIANFAN_DEFAULT_MODEL_ID
	});
}
function applyQianfanConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyQianfanProviderConfig(cfg), QIANFAN_DEFAULT_MODEL_REF);
}
function applyModelStudioProviderConfigWithBaseUrl(cfg, baseUrl) {
	const models = { ...cfg.agents?.defaults?.models };
	for (const modelId of [
		"qwen3.5-plus",
		"qwen3-max-2026-01-23",
		"qwen3-coder-next",
		"qwen3-coder-plus",
		"MiniMax-M2.5",
		"glm-5",
		"glm-4.7",
		"kimi-k2.5"
	]) {
		const modelRef = `modelstudio/${modelId}`;
		if (!models[modelRef]) models[modelRef] = {};
	}
	models[MODELSTUDIO_DEFAULT_MODEL_REF] = {
		...models[MODELSTUDIO_DEFAULT_MODEL_REF],
		alias: models[MODELSTUDIO_DEFAULT_MODEL_REF]?.alias ?? "Qwen"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.modelstudio;
	const defaultModels = [
		buildModelStudioModelDefinition({ id: "qwen3.5-plus" }),
		buildModelStudioModelDefinition({ id: "qwen3-max-2026-01-23" }),
		buildModelStudioModelDefinition({ id: "qwen3-coder-next" }),
		buildModelStudioModelDefinition({ id: "qwen3-coder-plus" }),
		buildModelStudioModelDefinition({ id: "MiniMax-M2.5" }),
		buildModelStudioModelDefinition({ id: "glm-5" }),
		buildModelStudioModelDefinition({ id: "glm-4.7" }),
		buildModelStudioModelDefinition({ id: "kimi-k2.5" })
	];
	const mergedModels = mergeProviderModels(existingProvider, defaultModels);
	const { apiKey: _existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = getNormalizedProviderApiKey(existingProvider);
	providers.modelstudio = {
		...existingProviderRest,
		baseUrl,
		api: "openai-completions",
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : defaultModels
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applyModelStudioProviderConfig(cfg) {
	return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_GLOBAL_BASE_URL);
}
function applyModelStudioProviderConfigCn(cfg) {
	return applyModelStudioProviderConfigWithBaseUrl(cfg, MODELSTUDIO_CN_BASE_URL);
}
function applyModelStudioConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyModelStudioProviderConfig(cfg), MODELSTUDIO_DEFAULT_MODEL_REF);
}
function applyModelStudioConfigCn(cfg) {
	return applyAgentDefaultModelPrimary(applyModelStudioProviderConfigCn(cfg), MODELSTUDIO_DEFAULT_MODEL_REF);
}
//#endregion
export { VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF as C, CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF as D, buildApiKeyCredential as E, buildCloudflareAiGatewayModelDefinition as O, TOGETHER_DEFAULT_MODEL_REF as S, ZAI_DEFAULT_MODEL_REF as T, applyZaiProviderConfig as _, applyModelStudioConfig as a, HUGGINGFACE_DEFAULT_MODEL_REF as b, applyMoonshotConfigCn as c, applySyntheticConfig as d, applyTogetherConfig as f, applyZaiConfig as g, applyXiaomiConfig as h, applyMistralConfig as i, resolveCloudflareAiGatewayBaseUrl as k, applyOpenrouterConfig as l, applyXaiConfig as m, applyKilocodeConfig as n, applyModelStudioConfigCn as o, applyVeniceConfig as p, applyKimiCodeConfig as r, applyMoonshotConfig as s, applyHuggingfaceConfig as t, applyQianfanConfig as u, applyCloudflareAiGatewayConfig as v, XIAOMI_DEFAULT_MODEL_REF as w, OPENROUTER_DEFAULT_MODEL_REF as x, applyVercelAiGatewayConfig as y };
