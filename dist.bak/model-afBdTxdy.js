import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Dn as resolveOpenClawAgentDir, Vn as normalizeProviderId, Zr as DEFAULT_CONTEXT_TOKENS } from "./auth-profiles-D6H-HVV8.js";
import { n as discoverModels, t as discoverAuthStorage } from "./pi-model-discovery-D0GqAM5X.js";

//#region src/agents/model-alias-lines.ts
function buildModelAliasLines(cfg) {
	const models = cfg?.agents?.defaults?.models ?? {};
	const entries = [];
	for (const [keyRaw, entryRaw] of Object.entries(models)) {
		const model = String(keyRaw ?? "").trim();
		if (!model) continue;
		const alias = String(entryRaw?.alias ?? "").trim();
		if (!alias) continue;
		entries.push({
			alias,
			model
		});
	}
	return entries.toSorted((a, b) => a.alias.localeCompare(b.alias)).map((entry) => `- ${entry.alias}: ${entry.model}`);
}

//#endregion
//#region src/agents/model-compat.ts
function isOpenAiCompletionsModel(model) {
	return model.api === "openai-completions";
}
function isDashScopeCompatibleEndpoint(baseUrl) {
	return baseUrl.includes("dashscope.aliyuncs.com") || baseUrl.includes("dashscope-intl.aliyuncs.com") || baseUrl.includes("dashscope-us.aliyuncs.com");
}
function isAnthropicMessagesModel(model) {
	return model.api === "anthropic-messages";
}
/**
* pi-ai constructs the Anthropic API endpoint as `${baseUrl}/v1/messages`.
* If a user configures `baseUrl` with a trailing `/v1` (e.g. the previously
* recommended format "https://api.anthropic.com/v1"), the resulting URL
* becomes "…/v1/v1/messages" which the Anthropic API rejects with a 404.
*
* Strip a single trailing `/v1` (with optional trailing slash) from the
* baseUrl for anthropic-messages models so users with either format work.
*/
function normalizeAnthropicBaseUrl(baseUrl) {
	return baseUrl.replace(/\/v1\/?$/, "");
}
function normalizeModelCompat(model) {
	const baseUrl = model.baseUrl ?? "";
	if (isAnthropicMessagesModel(model) && baseUrl) {
		const normalised = normalizeAnthropicBaseUrl(baseUrl);
		if (normalised !== baseUrl) return {
			...model,
			baseUrl: normalised
		};
	}
	const isZai = model.provider === "zai" || baseUrl.includes("api.z.ai");
	const isMoonshot = model.provider === "moonshot" || baseUrl.includes("moonshot.ai") || baseUrl.includes("moonshot.cn");
	const isDashScope = model.provider === "dashscope" || isDashScopeCompatibleEndpoint(baseUrl);
	if (!isZai && !isMoonshot && !isDashScope || !isOpenAiCompletionsModel(model)) return model;
	const openaiModel = model;
	const compat = openaiModel.compat ?? void 0;
	if (compat?.supportsDeveloperRole === false) return model;
	openaiModel.compat = compat ? {
		...compat,
		supportsDeveloperRole: false
	} : { supportsDeveloperRole: false };
	return openaiModel;
}

//#endregion
//#region src/agents/model-forward-compat.ts
const OPENAI_CODEX_GPT_53_MODEL_ID = "gpt-5.3-codex";
const OPENAI_CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.2-codex"];
const ANTHROPIC_OPUS_46_MODEL_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_MODEL_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS = ["claude-opus-4-5", "claude-opus-4.5"];
const ANTHROPIC_SONNET_46_MODEL_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_MODEL_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"];
const ZAI_GLM5_MODEL_ID = "glm-5";
const ZAI_GLM5_TEMPLATE_MODEL_IDS = ["glm-4.7"];
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3-pro-preview"];
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"];
function cloneFirstTemplateModel(params) {
	const { normalizedProvider, trimmedModelId, templateIds, modelRegistry } = params;
	for (const templateId of [...new Set(templateIds)].filter(Boolean)) {
		const template = modelRegistry.find(normalizedProvider, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId,
			...params.patch
		});
	}
}
const CODEX_GPT53_ELIGIBLE_PROVIDERS = new Set(["openai-codex", "github-copilot"]);
function resolveOpenAICodexGpt53FallbackModel(provider, modelId, modelRegistry) {
	const normalizedProvider = normalizeProviderId(provider);
	const trimmedModelId = modelId.trim();
	if (!CODEX_GPT53_ELIGIBLE_PROVIDERS.has(normalizedProvider)) return;
	if (trimmedModelId.toLowerCase() !== OPENAI_CODEX_GPT_53_MODEL_ID) return;
	for (const templateId of OPENAI_CODEX_TEMPLATE_MODEL_IDS) {
		const template = modelRegistry.find(normalizedProvider, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId
		});
	}
	return normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		api: "openai-codex-responses",
		provider: normalizedProvider,
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: DEFAULT_CONTEXT_TOKENS,
		maxTokens: DEFAULT_CONTEXT_TOKENS
	});
}
function resolveAnthropic46ForwardCompatModel(params) {
	const { provider, modelId, modelRegistry, dashModelId, dotModelId } = params;
	const normalizedProvider = normalizeProviderId(provider);
	if (normalizedProvider !== "anthropic") return;
	const trimmedModelId = modelId.trim();
	const lower = trimmedModelId.toLowerCase();
	if (!(lower === dashModelId || lower === dotModelId || lower.startsWith(`${dashModelId}-`) || lower.startsWith(`${dotModelId}-`))) return;
	const templateIds = [];
	if (lower.startsWith(dashModelId)) templateIds.push(lower.replace(dashModelId, params.dashTemplateId));
	if (lower.startsWith(dotModelId)) templateIds.push(lower.replace(dotModelId, params.dotTemplateId));
	templateIds.push(...params.fallbackTemplateIds);
	return cloneFirstTemplateModel({
		normalizedProvider,
		trimmedModelId,
		templateIds,
		modelRegistry
	});
}
function resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) {
	return resolveAnthropic46ForwardCompatModel({
		provider,
		modelId,
		modelRegistry,
		dashModelId: ANTHROPIC_OPUS_46_MODEL_ID,
		dotModelId: ANTHROPIC_OPUS_46_DOT_MODEL_ID,
		dashTemplateId: "claude-opus-4-5",
		dotTemplateId: "claude-opus-4.5",
		fallbackTemplateIds: ANTHROPIC_OPUS_TEMPLATE_MODEL_IDS
	});
}
function resolveAnthropicSonnet46ForwardCompatModel(provider, modelId, modelRegistry) {
	return resolveAnthropic46ForwardCompatModel({
		provider,
		modelId,
		modelRegistry,
		dashModelId: ANTHROPIC_SONNET_46_MODEL_ID,
		dotModelId: ANTHROPIC_SONNET_46_DOT_MODEL_ID,
		dashTemplateId: "claude-sonnet-4-5",
		dotTemplateId: "claude-sonnet-4.5",
		fallbackTemplateIds: ANTHROPIC_SONNET_TEMPLATE_MODEL_IDS
	});
}
function resolveGoogleGeminiCli31ForwardCompatModel(provider, modelId, modelRegistry) {
	if (normalizeProviderId(provider) !== "google-gemini-cli") return;
	const trimmed = modelId.trim();
	const lower = trimmed.toLowerCase();
	let templateIds;
	if (lower.startsWith(GEMINI_3_1_PRO_PREFIX)) templateIds = GEMINI_3_1_PRO_TEMPLATE_IDS;
	else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX)) templateIds = GEMINI_3_1_FLASH_TEMPLATE_IDS;
	else return;
	return cloneFirstTemplateModel({
		normalizedProvider: "google-gemini-cli",
		trimmedModelId: trimmed,
		templateIds: [...templateIds],
		modelRegistry,
		patch: { reasoning: true }
	});
}
function resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) {
	if (normalizeProviderId(provider) !== "zai") return;
	const trimmed = modelId.trim();
	const lower = trimmed.toLowerCase();
	if (lower !== ZAI_GLM5_MODEL_ID && !lower.startsWith(`${ZAI_GLM5_MODEL_ID}-`)) return;
	for (const templateId of ZAI_GLM5_TEMPLATE_MODEL_IDS) {
		const template = modelRegistry.find("zai", templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmed,
			name: trimmed,
			reasoning: true
		});
	}
	return normalizeModelCompat({
		id: trimmed,
		name: trimmed,
		api: "openai-completions",
		provider: "zai",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: DEFAULT_CONTEXT_TOKENS,
		maxTokens: DEFAULT_CONTEXT_TOKENS
	});
}
function resolveForwardCompatModel(provider, modelId, modelRegistry) {
	return resolveOpenAICodexGpt53FallbackModel(provider, modelId, modelRegistry) ?? resolveAnthropicOpus46ForwardCompatModel(provider, modelId, modelRegistry) ?? resolveAnthropicSonnet46ForwardCompatModel(provider, modelId, modelRegistry) ?? resolveZaiGlm5ForwardCompatModel(provider, modelId, modelRegistry) ?? resolveGoogleGeminiCli31ForwardCompatModel(provider, modelId, modelRegistry);
}

//#endregion
//#region src/agents/pi-embedded-runner/model.ts
var model_exports = /* @__PURE__ */ __exportAll({
	buildInlineProviderModels: () => buildInlineProviderModels,
	resolveModel: () => resolveModel
});
function buildInlineProviderModels(providers) {
	return Object.entries(providers).flatMap(([providerId, entry]) => {
		const trimmed = providerId.trim();
		if (!trimmed) return [];
		return (entry?.models ?? []).map((model) => ({
			...model,
			provider: trimmed,
			baseUrl: entry?.baseUrl,
			api: model.api ?? entry?.api
		}));
	});
}
function resolveModel(provider, modelId, agentDir, cfg) {
	const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
	const authStorage = discoverAuthStorage(resolvedAgentDir);
	const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
	const model = modelRegistry.find(provider, modelId);
	if (!model) {
		const providers = cfg?.models?.providers ?? {};
		const inlineModels = buildInlineProviderModels(providers);
		const normalizedProvider = normalizeProviderId(provider);
		const inlineMatch = inlineModels.find((entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId);
		if (inlineMatch) return {
			model: normalizeModelCompat(inlineMatch),
			authStorage,
			modelRegistry
		};
		const forwardCompat = resolveForwardCompatModel(provider, modelId, modelRegistry);
		if (forwardCompat) return {
			model: forwardCompat,
			authStorage,
			modelRegistry
		};
		if (normalizedProvider === "openrouter") return {
			model: normalizeModelCompat({
				id: modelId,
				name: modelId,
				api: "openai-completions",
				provider,
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0
				},
				contextWindow: DEFAULT_CONTEXT_TOKENS,
				maxTokens: 8192
			}),
			authStorage,
			modelRegistry
		};
		const providerCfg = providers[provider];
		if (providerCfg || modelId.startsWith("mock-")) {
			const configuredModel = providerCfg?.models?.find((candidate) => candidate.id === modelId);
			return {
				model: normalizeModelCompat({
					id: modelId,
					name: modelId,
					api: providerCfg?.api ?? "openai-responses",
					provider,
					baseUrl: providerCfg?.baseUrl,
					reasoning: configuredModel?.reasoning ?? false,
					input: ["text"],
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0
					},
					contextWindow: configuredModel?.contextWindow ?? providerCfg?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
					maxTokens: configuredModel?.maxTokens ?? providerCfg?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS
				}),
				authStorage,
				modelRegistry
			};
		}
		return {
			error: buildUnknownModelError(provider, modelId),
			authStorage,
			modelRegistry
		};
	}
	return {
		model: normalizeModelCompat(model),
		authStorage,
		modelRegistry
	};
}
/**
* Build a more helpful error when the model is not found.
*
* Local providers (ollama, vllm) need a dummy API key to be registered.
* Users often configure `agents.defaults.model.primary: "ollama/…"` but
* forget to set `OLLAMA_API_KEY`, resulting in a confusing "Unknown model"
* error.  This detects known providers that require opt-in auth and adds
* a hint.
*
* See: https://github.com/openclaw/openclaw/issues/17328
*/
const LOCAL_PROVIDER_HINTS = {
	ollama: "Ollama requires authentication to be registered as a provider. Set OLLAMA_API_KEY=\"ollama-local\" (any value works) or run \"openclaw configure\". See: https://docs.openclaw.ai/providers/ollama",
	vllm: "vLLM requires authentication to be registered as a provider. Set VLLM_API_KEY (any value works) or run \"openclaw configure\". See: https://docs.openclaw.ai/providers/vllm"
};
function buildUnknownModelError(provider, modelId) {
	const base = `Unknown model: ${provider}/${modelId}`;
	const hint = LOCAL_PROVIDER_HINTS[provider.toLowerCase()];
	return hint ? `${base}. ${hint}` : base;
}

//#endregion
export { buildModelAliasLines as i, resolveModel as n, resolveForwardCompatModel as r, model_exports as t };