import { n as buildProviderToolCompatFamilyHooks } from "../../provider-tools-BiMT5vRn.js";
import { t as definePluginEntry } from "../../plugin-entry-BW8FQC_w.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-Cognmgu-.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-C8salOq2.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-LlVXmLpT.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-luw9Bhh4.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-Be0H1GbK.js";
import { t as buildOpenAIProvider } from "../../openai-provider-Da0N394-.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-B-LRYLmv.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DYXo4xVV.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-Cu1tENGm.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-Bp0qs8eF.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-s2og7a81.js";
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
