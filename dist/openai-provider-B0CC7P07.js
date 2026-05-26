import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import "./defaults-mDjiWzE5.js";
import { a as normalizeModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { l as cloneFirstTemplateModel, u as matchesExactOrPrefix } from "./provider-model-shared-DtsPmvDx.js";
import { t as createProviderApiKeyAuthMethod } from "./provider-api-key-auth-E_5Yag4W.js";
import "./provider-auth-api-key-C06h8GOX.js";
import { l as findCatalogTemplate } from "./provider-catalog-shared-BLp5nwNN.js";
import { r as isOpenAIApiBaseUrl } from "./base-url-UKY1cn1G.js";
import { a as OPENAI_DEFAULT_MODEL, c as applyOpenAIConfig } from "./default-models-9Fo5IjIh.js";
import { n as buildOpenAISyntheticCatalogEntry, t as buildOpenAIResponsesProviderHooks } from "./shared-CrBPnArW.js";
import { n as OPENAI_API_KEY_LABEL, t as OPENAI_ACCOUNT_WIZARD_GROUP } from "./auth-choice-copy-CI2uePXw.js";
import { n as resolveOpenAIThinkingProfile } from "./thinking-policy-CkZmF4BG.js";
//#region extensions/openai/openai-provider.ts
const PROVIDER_ID = "openai";
const OPENAI_CHAT_LATEST_MODEL_ID = "chat-latest";
const OPENAI_GPT_55_MODEL_ID = "gpt-5.5";
const OPENAI_GPT_55_PRO_MODEL_ID = "gpt-5.5-pro";
const OPENAI_GPT_54_MODEL_ID = "gpt-5.4";
const OPENAI_GPT_54_PRO_MODEL_ID = "gpt-5.4-pro";
const OPENAI_GPT_54_MINI_MODEL_ID = "gpt-5.4-mini";
const OPENAI_GPT_54_NANO_MODEL_ID = "gpt-5.4-nano";
const OPENAI_GPT_55_PRO_CONTEXT_TOKENS = 1e6;
const OPENAI_GPT_54_CONTEXT_TOKENS = 105e4;
const OPENAI_GPT_54_PRO_CONTEXT_TOKENS = 105e4;
const OPENAI_GPT_54_MINI_CONTEXT_TOKENS = 4e5;
const OPENAI_GPT_54_NANO_CONTEXT_TOKENS = 4e5;
const OPENAI_GPT_54_MAX_TOKENS = 128e3;
const OPENAI_CHAT_LATEST_COST = {
	input: 5,
	output: 30,
	cacheRead: .5,
	cacheWrite: 0
};
const OPENAI_GPT_55_PRO_COST = {
	input: 30,
	output: 180,
	cacheRead: 0,
	cacheWrite: 0
};
const OPENAI_GPT_54_COST = {
	input: 2.5,
	output: 15,
	cacheRead: .25,
	cacheWrite: 0
};
const OPENAI_GPT_54_PRO_COST = {
	input: 30,
	output: 180,
	cacheRead: 0,
	cacheWrite: 0
};
const OPENAI_GPT_54_MINI_COST = {
	input: .75,
	output: 4.5,
	cacheRead: .075,
	cacheWrite: 0
};
const OPENAI_GPT_54_NANO_COST = {
	input: .2,
	output: 1.25,
	cacheRead: .02,
	cacheWrite: 0
};
const OPENAI_GPT_55_PRO_TEMPLATE_MODEL_IDS = [
	OPENAI_GPT_54_PRO_MODEL_ID,
	OPENAI_GPT_54_MODEL_ID,
	"gpt-5.2-pro",
	"gpt-5.2"
];
const OPENAI_GPT_54_TEMPLATE_MODEL_IDS = ["gpt-5.2"];
const OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS = ["gpt-5.2-pro", "gpt-5.2"];
const OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS = ["gpt-5-mini"];
const OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS = ["gpt-5-nano", "gpt-5-mini"];
const OPENAI_CHAT_LATEST_TEMPLATE_MODEL_IDS = [
	OPENAI_GPT_55_MODEL_ID,
	OPENAI_GPT_54_MODEL_ID,
	"gpt-5.2"
];
const OPENAI_MODERN_MODEL_IDS = [
	OPENAI_CHAT_LATEST_MODEL_ID,
	OPENAI_GPT_55_MODEL_ID,
	OPENAI_GPT_55_PRO_MODEL_ID,
	OPENAI_GPT_54_MODEL_ID,
	OPENAI_GPT_54_PRO_MODEL_ID,
	OPENAI_GPT_54_MINI_MODEL_ID,
	OPENAI_GPT_54_NANO_MODEL_ID,
	"gpt-5.2"
];
function shouldUseOpenAIResponsesTransport(params) {
	if (params.api !== "openai-completions") return false;
	if (normalizeProviderId(params.provider) === PROVIDER_ID) return !params.baseUrl || isOpenAIApiBaseUrl(params.baseUrl);
	return typeof params.baseUrl === "string" && isOpenAIApiBaseUrl(params.baseUrl);
}
function normalizeOpenAITransport(model) {
	if (!shouldUseOpenAIResponsesTransport({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl
	})) return model;
	return {
		...model,
		api: "openai-responses"
	};
}
function resolveOpenAIGptForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	const lower = normalizeLowercaseStringOrEmpty(trimmedModelId);
	let templateIds;
	let patch;
	if (lower === OPENAI_CHAT_LATEST_MODEL_ID) {
		templateIds = OPENAI_CHAT_LATEST_TEMPLATE_MODEL_IDS;
		patch = {
			api: "openai-responses",
			provider: PROVIDER_ID,
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: OPENAI_CHAT_LATEST_COST,
			contextWindow: 4e5,
			maxTokens: OPENAI_GPT_54_MAX_TOKENS
		};
	} else if (lower === OPENAI_GPT_55_PRO_MODEL_ID) {
		templateIds = OPENAI_GPT_55_PRO_TEMPLATE_MODEL_IDS;
		patch = {
			api: "openai-responses",
			provider: PROVIDER_ID,
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: OPENAI_GPT_55_PRO_COST,
			contextWindow: OPENAI_GPT_55_PRO_CONTEXT_TOKENS,
			maxTokens: OPENAI_GPT_54_MAX_TOKENS
		};
	} else if (lower === OPENAI_GPT_54_MODEL_ID) {
		templateIds = OPENAI_GPT_54_TEMPLATE_MODEL_IDS;
		patch = {
			api: "openai-responses",
			provider: PROVIDER_ID,
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: OPENAI_GPT_54_COST,
			contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS,
			maxTokens: OPENAI_GPT_54_MAX_TOKENS
		};
	} else if (lower === OPENAI_GPT_54_PRO_MODEL_ID) {
		templateIds = OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS;
		patch = {
			api: "openai-responses",
			provider: PROVIDER_ID,
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: OPENAI_GPT_54_PRO_COST,
			contextWindow: OPENAI_GPT_54_PRO_CONTEXT_TOKENS,
			maxTokens: OPENAI_GPT_54_MAX_TOKENS
		};
	} else if (lower === OPENAI_GPT_54_MINI_MODEL_ID) {
		templateIds = OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS;
		patch = {
			api: "openai-responses",
			provider: PROVIDER_ID,
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: OPENAI_GPT_54_MINI_COST,
			contextWindow: OPENAI_GPT_54_MINI_CONTEXT_TOKENS,
			maxTokens: OPENAI_GPT_54_MAX_TOKENS
		};
	} else if (lower === OPENAI_GPT_54_NANO_MODEL_ID) {
		templateIds = OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS;
		patch = {
			api: "openai-responses",
			provider: PROVIDER_ID,
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: OPENAI_GPT_54_NANO_COST,
			contextWindow: OPENAI_GPT_54_NANO_CONTEXT_TOKENS,
			maxTokens: OPENAI_GPT_54_MAX_TOKENS
		};
	} else return;
	return cloneFirstTemplateModel({
		providerId: PROVIDER_ID,
		modelId: trimmedModelId,
		templateIds,
		ctx,
		patch
	}) ?? normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		...patch,
		cost: patch.cost ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: patch.contextWindow ?? 2e5,
		maxTokens: patch.maxTokens ?? 2e5
	});
}
function buildOpenAIProvider() {
	return {
		id: PROVIDER_ID,
		label: "OpenAI",
		hookAliases: ["azure-openai", "azure-openai-responses"],
		docsPath: "/providers/models",
		envVars: ["OPENAI_API_KEY"],
		auth: [createProviderApiKeyAuthMethod({
			providerId: PROVIDER_ID,
			methodId: "api-key",
			label: OPENAI_API_KEY_LABEL,
			hint: "Use your OpenAI API key directly",
			optionKey: "openaiApiKey",
			flagName: "--openai-api-key",
			envVar: "OPENAI_API_KEY",
			promptMessage: "Enter OpenAI API key",
			defaultModel: OPENAI_DEFAULT_MODEL,
			expectedProviders: ["openai"],
			applyConfig: (cfg) => applyOpenAIConfig(cfg),
			wizard: {
				choiceId: "openai-api-key",
				choiceLabel: OPENAI_API_KEY_LABEL,
				choiceHint: "Use your OpenAI API key directly",
				assistantPriority: 5,
				...OPENAI_ACCOUNT_WIZARD_GROUP
			}
		})],
		resolveDynamicModel: (ctx) => resolveOpenAIGptForwardCompatModel(ctx),
		normalizeResolvedModel: (ctx) => {
			if (normalizeProviderId(ctx.provider) !== PROVIDER_ID) return;
			return normalizeOpenAITransport(ctx.model);
		},
		normalizeTransport: ({ provider, api, baseUrl }) => shouldUseOpenAIResponsesTransport({
			provider,
			api,
			baseUrl
		}) ? {
			api: "openai-responses",
			baseUrl
		} : void 0,
		...buildOpenAIResponsesProviderHooks({ transport: "sse" }),
		matchesContextOverflowError: ({ errorMessage }) => /content_filter.*(?:prompt|input).*(?:too long|exceed)/i.test(errorMessage),
		resolveReasoningOutputMode: () => "native",
		resolveThinkingProfile: ({ modelId }) => resolveOpenAIThinkingProfile(modelId),
		isModernModelRef: ({ modelId }) => matchesExactOrPrefix(modelId, OPENAI_MODERN_MODEL_IDS),
		buildMissingAuthMessage: (ctx) => {
			if (ctx.provider !== PROVIDER_ID || ctx.listProfileIds("openai-codex").length === 0) return;
			return "No API key found for provider \"openai\". You are authenticated with OpenAI Codex OAuth; OpenAI agent model runs use openai/gpt-* through the Codex runtime. Set OPENAI_API_KEY only for direct OpenAI API-key surfaces.";
		},
		augmentModelCatalog: (ctx) => {
			const openAiGpt55ProTemplate = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_GPT_55_PRO_TEMPLATE_MODEL_IDS
			});
			const openAiGpt54Template = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_GPT_54_TEMPLATE_MODEL_IDS
			});
			const openAiGpt54ProTemplate = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_GPT_54_PRO_TEMPLATE_MODEL_IDS
			});
			const openAiGpt54MiniTemplate = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_GPT_54_MINI_TEMPLATE_MODEL_IDS
			});
			const openAiGpt54NanoTemplate = findCatalogTemplate({
				entries: ctx.entries,
				providerId: PROVIDER_ID,
				templateIds: OPENAI_GPT_54_NANO_TEMPLATE_MODEL_IDS
			});
			return [
				buildOpenAISyntheticCatalogEntry(openAiGpt55ProTemplate, {
					id: OPENAI_GPT_55_PRO_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_GPT_55_PRO_CONTEXT_TOKENS
				}),
				buildOpenAISyntheticCatalogEntry(openAiGpt54Template, {
					id: OPENAI_GPT_54_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_GPT_54_CONTEXT_TOKENS
				}),
				buildOpenAISyntheticCatalogEntry(openAiGpt54ProTemplate, {
					id: OPENAI_GPT_54_PRO_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_GPT_54_PRO_CONTEXT_TOKENS
				}),
				buildOpenAISyntheticCatalogEntry(openAiGpt54MiniTemplate, {
					id: OPENAI_GPT_54_MINI_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_GPT_54_MINI_CONTEXT_TOKENS
				}),
				buildOpenAISyntheticCatalogEntry(openAiGpt54NanoTemplate, {
					id: OPENAI_GPT_54_NANO_MODEL_ID,
					reasoning: true,
					input: ["text", "image"],
					contextWindow: OPENAI_GPT_54_NANO_CONTEXT_TOKENS
				})
			].filter((entry) => entry !== void 0);
		}
	};
}
//#endregion
export { buildOpenAIProvider as t };
