import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-Bt3SlS0_.js";
import { t as definePluginEntry } from "../../plugin-entry-BWGTdHUK.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-DjX01GH3.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-54RbYwOK.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-BW5OSbli.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-B8WRmKR5.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-BSKy6ah1.js";
import { t as buildOpenAIProvider } from "../../openai-provider-BS8f9rT6.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-Bp7jTIvu.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DT1MYeWW.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-OIrU-U-n.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-DsUKoWv7.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-TTM_32kf.js";
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
