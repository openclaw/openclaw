import { g as resolveStateDir } from "./paths-B4BZAPZh.js";
import { t as createSubsystemLogger } from "./subsystem-LTWJBEIv.js";
import { B as TOGETHER_MODEL_CATALOG, C as QIANFAN_BASE_URL, D as buildKimiCodingProvider, E as buildKilocodeProvider, F as VENICE_BASE_URL, G as buildSyntheticModelDefinition, H as SYNTHETIC_BASE_URL, I as VENICE_DEFAULT_MODEL_REF, Jr as KILOCODE_BASE_URL, L as VENICE_MODEL_CATALOG, O as buildQianfanProvider, R as buildVeniceModelDefinition, T as XIAOMI_DEFAULT_MODEL_ID, U as SYNTHETIC_DEFAULT_MODEL_REF, V as buildTogetherModelDefinition, W as SYNTHETIC_MODEL_CATALOG, Xr as DEFAULT_SECRET_PROVIDER_ALIAS, Yr as KILOCODE_DEFAULT_MODEL_REF, Zr as coerceSecretRef, ct as resolveCloudflareAiGatewayBaseUrl, d as normalizeProviderId, k as buildXiaomiProvider, kr as upsertAuthProfile, nt as HUGGINGFACE_MODEL_CATALOG, ot as CLOUDFLARE_AI_GATEWAY_DEFAULT_MODEL_REF, qr as normalizeSecretInput, rt as buildHuggingfaceModelDefinition, st as buildCloudflareAiGatewayModelDefinition, tt as HUGGINGFACE_BASE_URL, w as QIANFAN_DEFAULT_MODEL_ID, z as TOGETHER_BASE_URL, zr as resolveOpenClawAgentDir } from "./model-selection-DILdVnl8.js";
import { t as PROVIDER_ENV_VARS } from "./provider-env-vars-Dsu3ddZk.js";
import fs from "node:fs";
import path from "node:path";

//#region src/commands/onboard-auth.models.ts
const MINIMAX_API_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_CN_API_BASE_URL = "https://api.minimaxi.com/anthropic";
const MINIMAX_HOSTED_MODEL_ID = "MiniMax-M2.1";
const MINIMAX_HOSTED_MODEL_REF = `minimax/${MINIMAX_HOSTED_MODEL_ID}`;
const DEFAULT_MINIMAX_CONTEXT_WINDOW = 2e5;
const DEFAULT_MINIMAX_MAX_TOKENS = 8192;
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_MODEL_REF = `moonshot/${MOONSHOT_DEFAULT_MODEL_ID}`;
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256e3;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const KIMI_CODING_MODEL_ID = "k2p5";
const KIMI_CODING_MODEL_REF = `kimi-coding/${KIMI_CODING_MODEL_ID}`;
const QIANFAN_DEFAULT_MODEL_REF = `qianfan/${QIANFAN_DEFAULT_MODEL_ID}`;
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const ZAI_DEFAULT_MODEL_ID = "glm-5";
function resolveZaiBaseUrl(endpoint) {
	switch (endpoint) {
		case "coding-cn": return ZAI_CODING_CN_BASE_URL;
		case "global": return ZAI_GLOBAL_BASE_URL;
		case "cn": return ZAI_CN_BASE_URL;
		case "coding-global": return ZAI_CODING_GLOBAL_BASE_URL;
		default: return ZAI_GLOBAL_BASE_URL;
	}
}
const MINIMAX_API_COST = {
	input: .3,
	output: 1.2,
	cacheRead: .03,
	cacheWrite: .12
};
const MINIMAX_LM_STUDIO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MOONSHOT_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const ZAI_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MINIMAX_MODEL_CATALOG = {
	"MiniMax-M2.1": {
		name: "MiniMax M2.1",
		reasoning: false
	},
	"MiniMax-M2.1-lightning": {
		name: "MiniMax M2.1 Lightning",
		reasoning: false
	},
	"MiniMax-M2.5": {
		name: "MiniMax M2.5",
		reasoning: true
	},
	"MiniMax-M2.5-Lightning": {
		name: "MiniMax M2.5 Lightning",
		reasoning: true
	}
};
const ZAI_MODEL_CATALOG = {
	"glm-5": {
		name: "GLM-5",
		reasoning: true
	},
	"glm-4.7": {
		name: "GLM-4.7",
		reasoning: true
	},
	"glm-4.7-flash": {
		name: "GLM-4.7 Flash",
		reasoning: true
	},
	"glm-4.7-flashx": {
		name: "GLM-4.7 FlashX",
		reasoning: true
	}
};
function buildMinimaxModelDefinition(params) {
	const catalog = MINIMAX_MODEL_CATALOG[params.id];
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? `MiniMax ${params.id}`,
		reasoning: params.reasoning ?? catalog?.reasoning ?? false,
		input: ["text"],
		cost: params.cost,
		contextWindow: params.contextWindow,
		maxTokens: params.maxTokens
	};
}
function buildMinimaxApiModelDefinition(modelId) {
	return buildMinimaxModelDefinition({
		id: modelId,
		cost: MINIMAX_API_COST,
		contextWindow: DEFAULT_MINIMAX_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MINIMAX_MAX_TOKENS
	});
}
function buildMoonshotModelDefinition() {
	return {
		id: MOONSHOT_DEFAULT_MODEL_ID,
		name: "Kimi K2.5",
		reasoning: false,
		input: ["text", "image"],
		cost: MOONSHOT_DEFAULT_COST,
		contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
		maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS
	};
}
const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const MISTRAL_DEFAULT_MODEL_ID = "mistral-large-latest";
const MISTRAL_DEFAULT_MODEL_REF = `mistral/${MISTRAL_DEFAULT_MODEL_ID}`;
const MISTRAL_DEFAULT_CONTEXT_WINDOW = 262144;
const MISTRAL_DEFAULT_MAX_TOKENS = 262144;
const MISTRAL_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildMistralModelDefinition() {
	return {
		id: MISTRAL_DEFAULT_MODEL_ID,
		name: "Mistral Large",
		reasoning: false,
		input: ["text", "image"],
		cost: MISTRAL_DEFAULT_COST,
		contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
		maxTokens: MISTRAL_DEFAULT_MAX_TOKENS
	};
}
function buildZaiModelDefinition(params) {
	const catalog = ZAI_MODEL_CATALOG[params.id];
	return {
		id: params.id,
		name: params.name ?? catalog?.name ?? `GLM ${params.id}`,
		reasoning: params.reasoning ?? catalog?.reasoning ?? true,
		input: ["text"],
		cost: params.cost ?? ZAI_DEFAULT_COST,
		contextWindow: params.contextWindow ?? 204800,
		maxTokens: params.maxTokens ?? 131072
	};
}
const XAI_BASE_URL = "https://api.x.ai/v1";
const XAI_DEFAULT_MODEL_ID = "grok-4";
const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
const XAI_DEFAULT_CONTEXT_WINDOW = 131072;
const XAI_DEFAULT_MAX_TOKENS = 8192;
const XAI_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildXaiModelDefinition() {
	return {
		id: XAI_DEFAULT_MODEL_ID,
		name: "Grok 4",
		reasoning: false,
		input: ["text"],
		cost: XAI_DEFAULT_COST,
		contextWindow: XAI_DEFAULT_CONTEXT_WINDOW,
		maxTokens: XAI_DEFAULT_MAX_TOKENS
	};
}

//#endregion
//#region src/commands/onboard-auth.credentials.ts
const resolveAuthAgentDir = (agentDir) => agentDir ?? resolveOpenClawAgentDir();
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
/** Resolve real path, returning null if the target doesn't exist. */
function safeRealpathSync(dir) {
	try {
		return fs.realpathSync(path.resolve(dir));
	} catch {
		return null;
	}
}
function resolveSiblingAgentDirs(primaryAgentDir) {
	const normalized = path.resolve(primaryAgentDir);
	const parentOfAgent = path.dirname(normalized);
	const candidateAgentsRoot = path.dirname(parentOfAgent);
	const agentsRoot = path.basename(normalized) === "agent" && path.basename(candidateAgentsRoot) === "agents" ? candidateAgentsRoot : path.join(resolveStateDir(), "agents");
	const discovered = (() => {
		try {
			return fs.readdirSync(agentsRoot, { withFileTypes: true });
		} catch {
			return [];
		}
	})().filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(agentsRoot, entry.name, "agent"));
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const dir of [normalized, ...discovered]) {
		const real = safeRealpathSync(dir);
		if (real && !seen.has(real)) {
			seen.add(real);
			result.push(real);
		}
	}
	return result;
}
async function writeOAuthCredentials(provider, creds, agentDir, options) {
	const profileId = `${provider}:${typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default"}`;
	const resolvedAgentDir = path.resolve(resolveAuthAgentDir(agentDir));
	const targetAgentDirs = options?.syncSiblingAgents ? resolveSiblingAgentDirs(resolvedAgentDir) : [resolvedAgentDir];
	const credential = {
		type: "oauth",
		provider,
		...creds
	};
	upsertAuthProfile({
		profileId,
		credential,
		agentDir: resolvedAgentDir
	});
	if (options?.syncSiblingAgents) {
		const primaryReal = safeRealpathSync(resolvedAgentDir);
		for (const targetAgentDir of targetAgentDirs) {
			const targetReal = safeRealpathSync(targetAgentDir);
			if (targetReal && primaryReal && targetReal === primaryReal) continue;
			try {
				upsertAuthProfile({
					profileId,
					credential,
					agentDir: targetAgentDir
				});
			} catch {}
		}
	}
	return profileId;
}
async function setAnthropicApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "anthropic:default",
		credential: buildApiKeyCredential("anthropic", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setOpenaiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "openai:default",
		credential: buildApiKeyCredential("openai", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setGeminiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "google:default",
		credential: buildApiKeyCredential("google", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setMinimaxApiKey(key, agentDir, profileId = "minimax:default", options) {
	upsertAuthProfile({
		profileId,
		credential: buildApiKeyCredential(profileId.split(":")[0] ?? "minimax", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setMoonshotApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "moonshot:default",
		credential: buildApiKeyCredential("moonshot", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setKimiCodingApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "kimi-coding:default",
		credential: buildApiKeyCredential("kimi-coding", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setVolcengineApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "volcengine:default",
		credential: buildApiKeyCredential("volcengine", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setByteplusApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "byteplus:default",
		credential: buildApiKeyCredential("byteplus", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setSyntheticApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "synthetic:default",
		credential: buildApiKeyCredential("synthetic", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setVeniceApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "venice:default",
		credential: buildApiKeyCredential("venice", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
const ZAI_DEFAULT_MODEL_REF = "zai/glm-5";
const XIAOMI_DEFAULT_MODEL_REF = "xiaomi/mimo-v2-flash";
const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
const HUGGINGFACE_DEFAULT_MODEL_REF = "huggingface/deepseek-ai/DeepSeek-R1";
const TOGETHER_DEFAULT_MODEL_REF = "together/moonshotai/Kimi-K2.5";
const LITELLM_DEFAULT_MODEL_REF = "litellm/claude-opus-4-6";
const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";
async function setZaiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "zai:default",
		credential: buildApiKeyCredential("zai", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setXiaomiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "xiaomi:default",
		credential: buildApiKeyCredential("xiaomi", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setOpenrouterApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "openrouter:default",
		credential: buildApiKeyCredential("openrouter", typeof key === "string" && key === "undefined" ? "" : key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setCloudflareAiGatewayConfig(accountId, gatewayId, apiKey, agentDir, options) {
	upsertAuthProfile({
		profileId: "cloudflare-ai-gateway:default",
		credential: buildApiKeyCredential("cloudflare-ai-gateway", apiKey, {
			accountId: accountId.trim(),
			gatewayId: gatewayId.trim()
		}, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setLitellmApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "litellm:default",
		credential: buildApiKeyCredential("litellm", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setVercelAiGatewayApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "vercel-ai-gateway:default",
		credential: buildApiKeyCredential("vercel-ai-gateway", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setOpencodeZenApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "opencode:default",
		credential: buildApiKeyCredential("opencode", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setTogetherApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "together:default",
		credential: buildApiKeyCredential("together", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setHuggingfaceApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "huggingface:default",
		credential: buildApiKeyCredential("huggingface", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
function setQianfanApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "qianfan:default",
		credential: buildApiKeyCredential("qianfan", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
function setXaiApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "xai:default",
		credential: buildApiKeyCredential("xai", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setMistralApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "mistral:default",
		credential: buildApiKeyCredential("mistral", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}
async function setKilocodeApiKey(key, agentDir, options) {
	upsertAuthProfile({
		profileId: "kilocode:default",
		credential: buildApiKeyCredential("kilocode", key, void 0, options),
		agentDir: resolveAuthAgentDir(agentDir)
	});
}

//#endregion
//#region src/commands/onboard-auth.config-shared.ts
function extractAgentDefaultModelFallbacks(model) {
	if (!model || typeof model !== "object") return;
	if (!("fallbacks" in model)) return;
	const fallbacks = model.fallbacks;
	return Array.isArray(fallbacks) ? fallbacks.map((v) => String(v)) : void 0;
}
function applyOnboardAuthAgentModelsAndProviders(cfg, params) {
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models: params.agentModels
			}
		},
		models: {
			mode: cfg.models?.mode ?? "merge",
			providers: params.providers
		}
	};
}
function applyAgentDefaultModelPrimary(cfg, primary) {
	const existingFallbacks = extractAgentDefaultModelFallbacks(cfg.agents?.defaults?.model);
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				model: {
					...existingFallbacks ? { fallbacks: existingFallbacks } : void 0,
					primary
				}
			}
		}
	};
}
function applyProviderConfigWithDefaultModels(cfg, params) {
	const providerState = resolveProviderModelMergeState(cfg, params.providerId);
	const defaultModels = params.defaultModels;
	const defaultModelId = params.defaultModelId ?? defaultModels[0]?.id;
	const hasDefaultModel = defaultModelId ? providerState.existingModels.some((model) => model.id === defaultModelId) : true;
	const mergedModels = providerState.existingModels.length > 0 ? hasDefaultModel || defaultModels.length === 0 ? providerState.existingModels : [...providerState.existingModels, ...defaultModels] : defaultModels;
	return applyProviderConfigWithMergedModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		providerState,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels,
		fallbackModels: defaultModels
	});
}
function applyProviderConfigWithDefaultModel(cfg, params) {
	return applyProviderConfigWithDefaultModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		api: params.api,
		baseUrl: params.baseUrl,
		defaultModels: [params.defaultModel],
		defaultModelId: params.defaultModelId ?? params.defaultModel.id
	});
}
function applyProviderConfigWithModelCatalog(cfg, params) {
	const providerState = resolveProviderModelMergeState(cfg, params.providerId);
	const catalogModels = params.catalogModels;
	const mergedModels = providerState.existingModels.length > 0 ? [...providerState.existingModels, ...catalogModels.filter((model) => !providerState.existingModels.some((existing) => existing.id === model.id))] : catalogModels;
	return applyProviderConfigWithMergedModels(cfg, {
		agentModels: params.agentModels,
		providerId: params.providerId,
		providerState,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels,
		fallbackModels: catalogModels
	});
}
function resolveProviderModelMergeState(cfg, providerId) {
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers[providerId];
	return {
		providers,
		existingProvider,
		existingModels: Array.isArray(existingProvider?.models) ? existingProvider.models : []
	};
}
function applyProviderConfigWithMergedModels(cfg, params) {
	params.providerState.providers[params.providerId] = buildProviderConfig({
		existingProvider: params.providerState.existingProvider,
		api: params.api,
		baseUrl: params.baseUrl,
		mergedModels: params.mergedModels,
		fallbackModels: params.fallbackModels
	});
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: params.agentModels,
		providers: params.providerState.providers
	});
}
function buildProviderConfig(params) {
	const { apiKey: existingApiKey, ...existingProviderRest } = params.existingProvider ?? {};
	const normalizedApiKey = typeof existingApiKey === "string" ? existingApiKey.trim() : void 0;
	return {
		...existingProviderRest,
		baseUrl: params.baseUrl,
		api: params.api,
		...normalizedApiKey ? { apiKey: normalizedApiKey } : {},
		models: params.mergedModels.length > 0 ? params.mergedModels : params.fallbackModels
	};
}

//#endregion
//#region src/commands/onboard-auth.config-gateways.ts
function applyVercelAiGatewayProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF] = {
		...models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF],
		alias: models[VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF]?.alias ?? "Vercel AI Gateway"
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
//#region src/commands/onboard-auth.config-litellm.ts
const LITELLM_BASE_URL = "http://localhost:4000";
const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
const LITELLM_DEFAULT_CONTEXT_WINDOW = 128e3;
const LITELLM_DEFAULT_MAX_TOKENS = 8192;
const LITELLM_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
function buildLitellmModelDefinition() {
	return {
		id: LITELLM_DEFAULT_MODEL_ID,
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"],
		cost: LITELLM_DEFAULT_COST,
		contextWindow: LITELLM_DEFAULT_CONTEXT_WINDOW,
		maxTokens: LITELLM_DEFAULT_MAX_TOKENS
	};
}
function applyLitellmProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[LITELLM_DEFAULT_MODEL_REF] = {
		...models[LITELLM_DEFAULT_MODEL_REF],
		alias: models[LITELLM_DEFAULT_MODEL_REF]?.alias ?? "LiteLLM"
	};
	const defaultModel = buildLitellmModelDefinition();
	const existingProvider = cfg.models?.providers?.litellm;
	return applyProviderConfigWithDefaultModel(cfg, {
		agentModels: models,
		providerId: "litellm",
		api: "openai-completions",
		baseUrl: (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "") || LITELLM_BASE_URL,
		defaultModel,
		defaultModelId: LITELLM_DEFAULT_MODEL_ID
	});
}
function applyLitellmConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyLitellmProviderConfig(cfg), LITELLM_DEFAULT_MODEL_REF);
}

//#endregion
//#region src/commands/onboard-auth.config-core.ts
function applyZaiProviderConfig(cfg, params) {
	const modelRef = `zai/${params?.modelId?.trim() || ZAI_DEFAULT_MODEL_ID}`;
	const models = { ...cfg.agents?.defaults?.models };
	models[modelRef] = {
		...models[modelRef],
		alias: models[modelRef]?.alias ?? "GLM"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.zai;
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const defaultModels = [
		buildZaiModelDefinition({ id: "glm-5" }),
		buildZaiModelDefinition({ id: "glm-4.7" }),
		buildZaiModelDefinition({ id: "glm-4.7-flash" }),
		buildZaiModelDefinition({ id: "glm-4.7-flashx" })
	];
	const mergedModels = [...existingModels];
	const seen = new Set(existingModels.map((m) => m.id));
	for (const model of defaultModels) if (!seen.has(model.id)) {
		mergedModels.push(model);
		seen.add(model.id);
	}
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = (typeof existingApiKey === "string" ? existingApiKey : void 0)?.trim();
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
	const modelId = params?.modelId?.trim() || ZAI_DEFAULT_MODEL_ID;
	const modelRef = modelId === ZAI_DEFAULT_MODEL_ID ? ZAI_DEFAULT_MODEL_REF : `zai/${modelId}`;
	return applyAgentDefaultModelPrimary(applyZaiProviderConfig(cfg, params), modelRef);
}
function applyOpenrouterProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[OPENROUTER_DEFAULT_MODEL_REF] = {
		...models[OPENROUTER_DEFAULT_MODEL_REF],
		alias: models[OPENROUTER_DEFAULT_MODEL_REF]?.alias ?? "OpenRouter"
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
		alias: models[SYNTHETIC_DEFAULT_MODEL_REF]?.alias ?? "MiniMax M2.1"
	};
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers.synthetic;
	const existingModels = Array.isArray(existingProvider?.models) ? existingProvider.models : [];
	const syntheticModels = SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition);
	const mergedModels = [...existingModels, ...syntheticModels.filter((model) => !existingModels.some((existing) => existing.id === model.id))];
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {};
	const normalizedApiKey = (typeof existingApiKey === "string" ? existingApiKey : void 0)?.trim();
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
		alias: models[XIAOMI_DEFAULT_MODEL_REF]?.alias ?? "Xiaomi"
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
		alias: models[VENICE_DEFAULT_MODEL_REF]?.alias ?? "Llama 3.3 70B"
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
* Use this when Venice is the primary provider choice during onboarding.
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
		alias: models[TOGETHER_DEFAULT_MODEL_REF]?.alias ?? "Together AI"
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
* Use this when Together is the primary provider choice during onboarding.
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
		alias: models[HUGGINGFACE_DEFAULT_MODEL_REF]?.alias ?? "Hugging Face"
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
* Use this when Kilo Gateway is the primary provider choice during onboarding.
*/
function applyKilocodeConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyKilocodeProviderConfig(cfg), KILOCODE_DEFAULT_MODEL_REF);
}
function applyAuthProfileConfig(cfg, params) {
	const normalizedProvider = params.provider.toLowerCase();
	const profiles = {
		...cfg.auth?.profiles,
		[params.profileId]: {
			provider: params.provider,
			mode: params.mode,
			...params.email ? { email: params.email } : {}
		}
	};
	const configuredProviderProfiles = Object.entries(cfg.auth?.profiles ?? {}).filter(([, profile]) => profile.provider.toLowerCase() === normalizedProvider).map(([profileId, profile]) => ({
		profileId,
		mode: profile.mode
	}));
	const existingProviderOrder = cfg.auth?.order?.[params.provider];
	const preferProfileFirst = params.preferProfileFirst ?? true;
	const reorderedProviderOrder = existingProviderOrder && preferProfileFirst ? [params.profileId, ...existingProviderOrder.filter((profileId) => profileId !== params.profileId)] : existingProviderOrder;
	const hasMixedConfiguredModes = configuredProviderProfiles.some(({ profileId, mode }) => profileId !== params.profileId && mode !== params.mode);
	const derivedProviderOrder = existingProviderOrder === void 0 && preferProfileFirst && hasMixedConfiguredModes ? [params.profileId, ...configuredProviderProfiles.map(({ profileId }) => profileId).filter((profileId) => profileId !== params.profileId)] : void 0;
	const order = existingProviderOrder !== void 0 ? {
		...cfg.auth?.order,
		[params.provider]: reorderedProviderOrder?.includes(params.profileId) ? reorderedProviderOrder : [...reorderedProviderOrder ?? [], params.profileId]
	} : derivedProviderOrder ? {
		...cfg.auth?.order,
		[params.provider]: derivedProviderOrder
	} : cfg.auth?.order;
	return {
		...cfg,
		auth: {
			...cfg.auth,
			profiles,
			...order ? { order } : {}
		}
	};
}
function applyQianfanProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[QIANFAN_DEFAULT_MODEL_REF] = {
		...models[QIANFAN_DEFAULT_MODEL_REF],
		alias: models[QIANFAN_DEFAULT_MODEL_REF]?.alias ?? "QIANFAN"
	};
	const defaultProvider = buildQianfanProvider();
	const existingProvider = cfg.models?.providers?.qianfan;
	const resolvedBaseUrl = (typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "") || QIANFAN_BASE_URL;
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

//#endregion
//#region src/commands/onboard-auth.config-minimax.ts
function applyMinimaxProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models["anthropic/claude-opus-4-6"] = {
		...models["anthropic/claude-opus-4-6"],
		alias: models["anthropic/claude-opus-4-6"]?.alias ?? "Opus"
	};
	models["lmstudio/minimax-m2.1-gs32"] = {
		...models["lmstudio/minimax-m2.1-gs32"],
		alias: models["lmstudio/minimax-m2.1-gs32"]?.alias ?? "Minimax"
	};
	const providers = { ...cfg.models?.providers };
	if (!providers.lmstudio) providers.lmstudio = {
		baseUrl: "http://127.0.0.1:1234/v1",
		apiKey: "lmstudio",
		api: "openai-responses",
		models: [buildMinimaxModelDefinition({
			id: "minimax-m2.1-gs32",
			name: "MiniMax M2.1 GS32",
			reasoning: false,
			cost: MINIMAX_LM_STUDIO_COST,
			contextWindow: 196608,
			maxTokens: 8192
		})]
	};
	return applyOnboardAuthAgentModelsAndProviders(cfg, {
		agentModels: models,
		providers
	});
}
function applyMinimaxConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyMinimaxProviderConfig(cfg), "lmstudio/minimax-m2.1-gs32");
}
function applyMinimaxApiProviderConfig(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_API_BASE_URL
	});
}
function applyMinimaxApiConfig(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiConfigWithBaseUrl(cfg, {
		providerId: "minimax",
		modelId,
		baseUrl: MINIMAX_API_BASE_URL
	});
}
function applyMinimaxApiProviderConfigCn(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiProviderConfigWithBaseUrl(cfg, {
		providerId: "minimax-cn",
		modelId,
		baseUrl: MINIMAX_CN_API_BASE_URL
	});
}
function applyMinimaxApiConfigCn(cfg, modelId = "MiniMax-M2.5") {
	return applyMinimaxApiConfigWithBaseUrl(cfg, {
		providerId: "minimax-cn",
		modelId,
		baseUrl: MINIMAX_CN_API_BASE_URL
	});
}
function applyMinimaxApiProviderConfigWithBaseUrl(cfg, params) {
	const providers = { ...cfg.models?.providers };
	const existingProvider = providers[params.providerId];
	const existingModels = existingProvider?.models ?? [];
	const apiModel = buildMinimaxApiModelDefinition(params.modelId);
	const mergedModels = existingModels.some((model) => model.id === params.modelId) ? existingModels : [...existingModels, apiModel];
	const { apiKey: existingApiKey, ...existingProviderRest } = existingProvider ?? {
		baseUrl: params.baseUrl,
		models: []
	};
	const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : void 0;
	const normalizedApiKey = resolvedApiKey?.trim() === "minimax" ? "" : resolvedApiKey;
	providers[params.providerId] = {
		...existingProviderRest,
		baseUrl: params.baseUrl,
		api: "anthropic-messages",
		authHeader: true,
		...normalizedApiKey?.trim() ? { apiKey: normalizedApiKey } : {},
		models: mergedModels.length > 0 ? mergedModels : [apiModel]
	};
	const models = { ...cfg.agents?.defaults?.models };
	const modelRef = `${params.providerId}/${params.modelId}`;
	models[modelRef] = {
		...models[modelRef],
		alias: "Minimax"
	};
	return {
		...cfg,
		agents: {
			...cfg.agents,
			defaults: {
				...cfg.agents?.defaults,
				models
			}
		},
		models: {
			mode: cfg.models?.mode ?? "merge",
			providers
		}
	};
}
function applyMinimaxApiConfigWithBaseUrl(cfg, params) {
	return applyAgentDefaultModelPrimary(applyMinimaxApiProviderConfigWithBaseUrl(cfg, params), `${params.providerId}/${params.modelId}`);
}

//#endregion
//#region src/agents/opencode-zen-models.ts
const log = createSubsystemLogger("opencode-zen-models");
const OPENCODE_ZEN_DEFAULT_MODEL = "claude-opus-4-6";
const OPENCODE_ZEN_DEFAULT_MODEL_REF = `opencode/${OPENCODE_ZEN_DEFAULT_MODEL}`;
const CACHE_TTL_MS = 3600 * 1e3;

//#endregion
//#region src/commands/onboard-auth.config-opencode.ts
function applyOpencodeZenProviderConfig(cfg) {
	const models = { ...cfg.agents?.defaults?.models };
	models[OPENCODE_ZEN_DEFAULT_MODEL_REF] = {
		...models[OPENCODE_ZEN_DEFAULT_MODEL_REF],
		alias: models[OPENCODE_ZEN_DEFAULT_MODEL_REF]?.alias ?? "Opus"
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
function applyOpencodeZenConfig(cfg) {
	return applyAgentDefaultModelPrimary(applyOpencodeZenProviderConfig(cfg), OPENCODE_ZEN_DEFAULT_MODEL_REF);
}

//#endregion
//#region src/commands/auth-token.ts
const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-";
const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;
const DEFAULT_TOKEN_PROFILE_NAME = "default";
function normalizeTokenProfileName(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return DEFAULT_TOKEN_PROFILE_NAME;
	return trimmed.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || DEFAULT_TOKEN_PROFILE_NAME;
}
function buildTokenProfileId(params) {
	return `${normalizeProviderId(params.provider)}:${normalizeTokenProfileName(params.name)}`;
}
function validateAnthropicSetupToken(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "Required";
	if (!trimmed.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)) return `Expected token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIX}`;
	if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) return "Token looks too short; paste the full setup-token";
}

//#endregion
export { ZAI_DEFAULT_MODEL_REF as $, applyTogetherConfig as A, ZAI_CODING_CN_BASE_URL as At, applyLitellmConfig as B, applyMoonshotProviderConfigCn as C, writeOAuthCredentials as Ct, applyQianfanProviderConfig as D, QIANFAN_DEFAULT_MODEL_REF as Dt, applyQianfanConfig as E, MOONSHOT_DEFAULT_MODEL_REF as Et, applyXaiProviderConfig as F, applyVercelAiGatewayProviderConfig as G, applyCloudflareAiGatewayConfig as H, applyXiaomiConfig as I, LITELLM_DEFAULT_MODEL_REF as J, applyAgentDefaultModelPrimary as K, applyXiaomiProviderConfig as L, applyVeniceConfig as M, ZAI_GLOBAL_BASE_URL as Mt, applyVeniceProviderConfig as N, applySyntheticConfig as O, XAI_DEFAULT_MODEL_REF as Ot, applyXaiConfig as P, XIAOMI_DEFAULT_MODEL_REF as Q, applyZaiConfig as R, applyMoonshotProviderConfig as S, setZaiApiKey as St, applyOpenrouterProviderConfig as T, MISTRAL_DEFAULT_MODEL_REF as Tt, applyCloudflareAiGatewayProviderConfig as U, applyLitellmProviderConfig as V, applyVercelAiGatewayConfig as W, TOGETHER_DEFAULT_MODEL_REF as X, OPENROUTER_DEFAULT_MODEL_REF as Y, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF as Z, applyKimiCodeProviderConfig as _, setVeniceApiKey as _t, applyMinimaxApiConfig as a, setKilocodeApiKey as at, applyMoonshotConfig as b, setXaiApiKey as bt, applyMinimaxApiProviderConfigCn as c, setMinimaxApiKey as ct, applyAuthProfileConfig as d, setOpenaiApiKey as dt, setAnthropicApiKey as et, applyHuggingfaceConfig as f, setOpencodeZenApiKey as ft, applyKimiCodeConfig as g, setTogetherApiKey as gt, applyKilocodeProviderConfig as h, setSyntheticApiKey as ht, applyOpencodeZenProviderConfig as i, setHuggingfaceApiKey as it, applyTogetherProviderConfig as j, ZAI_CODING_GLOBAL_BASE_URL as jt, applySyntheticProviderConfig as k, ZAI_CN_BASE_URL as kt, applyMinimaxConfig as l, setMistralApiKey as lt, applyKilocodeConfig as m, setQianfanApiKey as mt, validateAnthropicSetupToken as n, setCloudflareAiGatewayConfig as nt, applyMinimaxApiConfigCn as o, setKimiCodingApiKey as ot, applyHuggingfaceProviderConfig as p, setOpenrouterApiKey as pt, HUGGINGFACE_DEFAULT_MODEL_REF as q, applyOpencodeZenConfig as r, setGeminiApiKey as rt, applyMinimaxApiProviderConfig as s, setLitellmApiKey as st, buildTokenProfileId as t, setByteplusApiKey as tt, applyMinimaxProviderConfig as u, setMoonshotApiKey as ut, applyMistralConfig as v, setVercelAiGatewayApiKey as vt, applyOpenrouterConfig as w, KIMI_CODING_MODEL_REF as wt, applyMoonshotConfigCn as x, setXiaomiApiKey as xt, applyMistralProviderConfig as y, setVolcengineApiKey as yt, applyZaiProviderConfig as z };