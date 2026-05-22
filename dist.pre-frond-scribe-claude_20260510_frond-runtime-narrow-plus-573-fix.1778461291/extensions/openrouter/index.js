import "../../defaults-kkxFBlxd.js";
import { i as PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "../../provider-model-shared-BJrHvRZi.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-B_EKimML.js";
import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import "../../provider-auth-api-key-CvRzoDT3.js";
import { l as getOpenRouterModelCapabilities, u as loadOpenRouterModelCapabilities } from "../../provider-stream-DxfXkgL4.js";
import "../../provider-stream-family-qfirEFVm.js";
import { i as normalizeOpenRouterBaseUrl, n as buildOpenrouterProvider, r as isOpenRouterProxyReasoningUnsupportedModel, t as OPENROUTER_BASE_URL } from "../../provider-catalog-CSkLtvpc.js";
import { t as buildOpenRouterImageGenerationProvider } from "../../image-generation-provider-CNSefLTo.js";
import { t as openrouterMediaUnderstandingProvider } from "../../media-understanding-provider-DWaalek3.js";
import { n as applyOpenrouterConfig, t as OPENROUTER_DEFAULT_MODEL_REF } from "../../onboard-BIVyfQpB.js";
import { t as buildOpenRouterSpeechProvider } from "../../speech-provider-FeoaIJcB.js";
import { t as wrapOpenRouterProviderStream } from "../../stream-DNjqNm4m.js";
import { n as supportsOpenRouterXHighThinking, t as resolveOpenRouterThinkingProfile } from "../../thinking-policy-tlus54Hs.js";
import { t as listOpenRouterVideoModelCatalog } from "../../video-model-catalog-B2xCv2mO.js";
import { t as buildOpenRouterVideoGenerationProvider } from "../../video-generation-provider-BnAwNad9.js";
//#region extensions/openrouter/index.ts
const PROVIDER_ID = "openrouter";
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
	"anthropic/",
	"deepseek/",
	"moonshot/",
	"moonshotai/",
	"zai/"
];
function normalizeOpenRouterResolvedModel(model) {
	const normalizedBaseUrl = normalizeOpenRouterBaseUrl(model.baseUrl);
	const reasoning = isOpenRouterProxyReasoningUnsupportedModel(model.id) ? false : model.reasoning;
	if ((!normalizedBaseUrl || normalizedBaseUrl === model.baseUrl) && reasoning === model.reasoning) return;
	return {
		...model,
		...normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {},
		reasoning
	};
}
var openrouter_default = definePluginEntry({
	id: "openrouter",
	name: "OpenRouter Provider",
	description: "Bundled OpenRouter provider plugin",
	register(api) {
		function buildDynamicOpenRouterModel(ctx) {
			const capabilities = getOpenRouterModelCapabilities(ctx.modelId);
			return {
				id: ctx.modelId,
				name: capabilities?.name ?? ctx.modelId,
				api: "openai-completions",
				provider: PROVIDER_ID,
				baseUrl: OPENROUTER_BASE_URL,
				reasoning: (capabilities?.reasoning ?? false) && !isOpenRouterProxyReasoningUnsupportedModel(ctx.modelId),
				input: capabilities?.input ?? ["text"],
				cost: capabilities?.cost ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0
				},
				contextWindow: capabilities?.contextWindow ?? 2e5,
				maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS
			};
		}
		function isOpenRouterCacheTtlModel(modelId) {
			return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
		}
		api.registerProvider({
			id: PROVIDER_ID,
			label: "OpenRouter",
			docsPath: "/providers/models",
			envVars: ["OPENROUTER_API_KEY"],
			auth: [createProviderApiKeyAuthMethod({
				providerId: PROVIDER_ID,
				methodId: "api-key",
				label: "OpenRouter API key",
				hint: "API key",
				optionKey: "openrouterApiKey",
				flagName: "--openrouter-api-key",
				envVar: "OPENROUTER_API_KEY",
				promptMessage: "Enter OpenRouter API key",
				defaultModel: OPENROUTER_DEFAULT_MODEL_REF,
				expectedProviders: ["openrouter"],
				applyConfig: (cfg) => applyOpenrouterConfig(cfg),
				wizard: {
					choiceId: "openrouter-api-key",
					choiceLabel: "OpenRouter API key",
					groupId: "openrouter",
					groupLabel: "OpenRouter",
					groupHint: "API key"
				}
			})],
			catalog: {
				order: "simple",
				run: async (ctx) => {
					const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
					if (!apiKey) return null;
					return { provider: {
						...buildOpenrouterProvider(),
						apiKey
					} };
				}
			},
			staticCatalog: {
				order: "simple",
				run: async () => ({ provider: buildOpenrouterProvider() })
			},
			resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),
			prepareDynamicModel: async (ctx) => {
				await loadOpenRouterModelCapabilities(ctx.modelId);
			},
			normalizeConfig: ({ providerConfig }) => {
				const normalizedBaseUrl = normalizeOpenRouterBaseUrl(providerConfig.baseUrl);
				return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl ? {
					...providerConfig,
					baseUrl: normalizedBaseUrl
				} : void 0;
			},
			normalizeResolvedModel: ({ model }) => normalizeOpenRouterResolvedModel(model),
			normalizeTransport: ({ api, baseUrl }) => {
				const normalizedBaseUrl = normalizeOpenRouterBaseUrl(baseUrl);
				return normalizedBaseUrl && normalizedBaseUrl !== baseUrl ? {
					api,
					baseUrl: normalizedBaseUrl
				} : void 0;
			},
			...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
			resolveReasoningOutputMode: () => "native",
			supportsXHighThinking: ({ modelId }) => supportsOpenRouterXHighThinking(modelId),
			resolveThinkingProfile: ({ modelId }) => resolveOpenRouterThinkingProfile(modelId),
			isModernModelRef: () => true,
			wrapStreamFn: wrapOpenRouterProviderStream,
			isCacheTtlEligible: (ctx) => isOpenRouterCacheTtlModel(ctx.modelId)
		});
		api.registerMediaUnderstandingProvider(openrouterMediaUnderstandingProvider);
		api.registerImageGenerationProvider(buildOpenRouterImageGenerationProvider());
		api.registerVideoGenerationProvider(buildOpenRouterVideoGenerationProvider());
		api.registerModelCatalogProvider({
			provider: PROVIDER_ID,
			kinds: ["video_generation"],
			liveCatalog: listOpenRouterVideoModelCatalog
		});
		api.registerSpeechProvider(buildOpenRouterSpeechProvider());
	}
});
//#endregion
export { openrouter_default as default };
