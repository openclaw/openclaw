import { n as buildProviderToolCompatFamilyHooks } from "../../provider-tools-D8Ja_oUH.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-C7y_ltl1.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-QQswlsk2.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-DSMYyFlu.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-C062aIId.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-D5YBYlnG.js";
import { t as buildOpenAIProvider } from "../../openai-provider-C0AOIZOy.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-B82EnX4L.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-BQmcBPB6.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-C0kAYl6Q.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-CALixFxJ.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-BgG_CgMY.js";
//#region extensions/openai/index.ts
var openai_default = definePluginEntry({
	id: "openai",
	name: "OpenAI Provider",
	description: "Bundled OpenAI provider plugins",
	register(api) {
		const openAIToolCompatHooks = buildProviderToolCompatFamilyHooks("openai");
		const buildProviderWithPromptContribution = (provider) => ({
			...provider,
			...openAIToolCompatHooks,
			resolveSystemPromptContribution: (ctx) => {
				const pluginConfig = resolvePluginConfigObject(ctx.config, "openai") ?? (ctx.config ? void 0 : api.pluginConfig);
				return resolveOpenAISystemPromptContribution({
					config: ctx.config,
					legacyPluginConfig: pluginConfig,
					mode: resolveOpenAIPromptOverlayMode(pluginConfig),
					modelProviderId: provider.id,
					modelId: ctx.modelId,
					trigger: ctx.trigger
				});
			}
		});
		api.registerProvider(buildProviderWithPromptContribution(buildOpenAIProvider()));
		api.registerProvider(buildProviderWithPromptContribution(buildOpenAICodexProviderPlugin()));
		api.registerMemoryEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
		api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
		api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider());
		api.registerRealtimeVoiceProvider(buildOpenAIRealtimeVoiceProvider());
		api.registerSpeechProvider(buildOpenAISpeechProvider());
		api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
		api.registerMediaUnderstandingProvider(openaiCodexMediaUnderstandingProvider);
		api.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider());
	}
});
//#endregion
export { openai_default as default };
