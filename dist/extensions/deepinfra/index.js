import { i as PASSTHROUGH_GEMINI_REPLAY_HOOKS } from "../../provider-model-shared-D-slKnZa.js";
import { i as isProxyReasoningUnsupported, n as createOpenRouterSystemCacheWrapper, r as createOpenRouterWrapper } from "../../proxy-stream-wrappers-CIFovY1X.js";
import { a as readConfiguredProviderCatalogEntries } from "../../provider-catalog-shared-4kkagm5f.js";
import { t as defineSingleProviderPluginEntry } from "../../provider-entry-CDwzUX_P.js";
import "../../provider-stream-Cx3vdp_v.js";
import { r as DEEPINFRA_DEFAULT_MODEL_REF } from "../../provider-models-CgkEaU1x.js";
import { t as buildDeepInfraImageGenerationProvider } from "../../image-generation-provider-SdF1kyMG.js";
import { t as deepinfraMediaUnderstandingProvider } from "../../media-understanding-provider-CUOpfh5b.js";
import { t as deepinfraMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-CFAmpsnp.js";
import { t as applyDeepInfraConfig } from "../../onboard-DsRwrgkE.js";
import { n as buildStaticDeepInfraProvider, t as buildDeepInfraProvider } from "../../provider-catalog-lMFYC8pK.js";
import { t as buildDeepInfraSpeechProvider } from "../../speech-provider-jf5PN_iE.js";
import { t as buildDeepInfraVideoGenerationProvider } from "../../video-generation-provider-CP8BBzhE.js";
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
