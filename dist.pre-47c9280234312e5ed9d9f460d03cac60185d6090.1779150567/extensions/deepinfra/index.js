import { i as PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "../../provider-model-shared-DBCMc-LA.js";
import { i as isProxyReasoningUnsupported, n as createOpenRouterSystemCacheWrapper, r as createOpenRouterWrapper } from "../../proxy-stream-wrappers-GFeLarVw.js";
import { a as readConfiguredProviderCatalogEntries } from "../../provider-catalog-shared-Dv7tLTgy.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-BpVA6EeL.js";
import "../../provider-stream-CRS65u6j.js";
import { r as DEEPINFRA_DEFAULT_MODEL_REF } from "../../provider-models-C_ML3Rc4.js";
import { t as buildDeepInfraImageGenerationProvider } from "../../image-generation-provider-Bwjbg-bX.js";
import { t as deepinfraMediaUnderstandingProvider } from "../../media-understanding-provider-D-ZOY3W0.js";
import { t as deepinfraMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-BlrNPUsN.js";
import { t as applyDeepInfraConfig } from "../../onboard-CsSslSu_.js";
import { n as buildStaticDeepInfraProvider, t as buildDeepInfraProvider } from "../../provider-catalog-CQM8VLJ0.js";
import { t as buildDeepInfraSpeechProvider } from "../../speech-provider-k-0yVLCk.js";
import { t as buildDeepInfraVideoGenerationProvider } from "../../video-generation-provider-CBzDf47c.js";
//#region extensions/deepinfra/index.ts
const PROVIDER_ID = "deepinfra";
var deepinfra_default = defineSingleProviderPluginEntry({
	id: PROVIDER_ID,
	name: "DeepInfra Provider",
	description: "Bundled DeepInfra provider plugin",
	provider: {
		label: "DeepInfra",
		docsPath: "/providers/deepinfra",
		auth: [{
			methodId: "api-key",
			label: "DeepInfra API key",
			hint: "Unified API for open source models",
			optionKey: "deepinfraApiKey",
			flagName: "--deepinfra-api-key",
			envVar: "DEEPINFRA_API_KEY",
			promptMessage: "Enter DeepInfra API key",
			noteTitle: "DeepInfra",
			noteMessage: ["DeepInfra provides an OpenAI-compatible API for open source and frontier models.", "Get your API key at: https://deepinfra.com/dash/api_keys"].join("\n"),
			defaultModel: DEEPINFRA_DEFAULT_MODEL_REF,
			applyConfig: (cfg) => applyDeepInfraConfig(cfg),
			wizard: {
				choiceId: "deepinfra-api-key",
				choiceLabel: "DeepInfra API key",
				choiceHint: "Unified API for open source models",
				groupId: PROVIDER_ID,
				groupLabel: "DeepInfra",
				groupHint: "Unified API for open source models"
			}
		}],
		catalog: {
			buildProvider: buildDeepInfraProvider,
			buildStaticProvider: buildStaticDeepInfraProvider
		},
		augmentModelCatalog: ({ config }) => readConfiguredProviderCatalogEntries({
			config,
			providerId: PROVIDER_ID
		}),
		normalizeConfig: ({ providerConfig }) => providerConfig,
		normalizeTransport: ({ api, baseUrl }) => baseUrl === "https://api.deepinfra.com/v1/openai" ? {
			api,
			baseUrl
		} : void 0,
		...PASSTHROUGH_GEMINI_REPLAY_HOOKS,
		wrapStreamFn: (ctx) => {
			const thinkingLevel = isProxyReasoningUnsupported(ctx.modelId) ? void 0 : ctx.thinkingLevel;
			return createOpenRouterSystemCacheWrapper(createOpenRouterWrapper(ctx.streamFn, thinkingLevel));
		},
		isModernModelRef: () => true,
		isCacheTtlEligible: (ctx) => ctx.modelId.toLowerCase().startsWith("anthropic/")
	},
	register(api) {
		api.registerImageGenerationProvider(buildDeepInfraImageGenerationProvider());
		api.registerMediaUnderstandingProvider(deepinfraMediaUnderstandingProvider);
		api.registerMemoryEmbeddingProvider(deepinfraMemoryEmbeddingProviderAdapter);
		api.registerSpeechProvider(buildDeepInfraSpeechProvider());
		api.registerVideoGenerationProvider(buildDeepInfraVideoGenerationProvider());
	}
});
//#endregion
export { deepinfra_default as default };
