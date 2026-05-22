import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-BTWF-rOZ.js";
import { t as definePluginEntry } from "../../plugin-entry-DeObqXcQ.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-CJkf30el.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-Bf1pk7o6.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-BfEXHurW.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-CWYgPLGh.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-ClmAiF8K.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-CVOXElSs.js";
import { t as buildOpenAIProvider } from "../../openai-provider-ahs0x1ao.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-Bmf7lKSz.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-D1jBpk_a.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-B7rUdJiu.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-B79VnvOg.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-z-gCBUXB.js";
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
		api.registerCliBackend(buildOpenAICodexCliBackend());
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
