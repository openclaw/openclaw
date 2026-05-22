import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-55cEQTVH.js";
import { t as definePluginEntry } from "../../plugin-entry-qhhTPsFQ.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-OSczM597.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-CS9Vulf6.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-CAeAdrgU.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-Bbup3gM6.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-8M84fPM7.js";
import { t as buildOpenAIProvider } from "../../openai-provider-C8E4ov5p.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-DHj1CHTJ.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DPuTc3hv.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-DT6WNko_.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-CVzGDyOd.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-Cwpu3Xvv.js";
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
