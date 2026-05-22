import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-AcSjASfb.js";
import { t as definePluginEntry } from "../../plugin-entry-DFlZXTDz.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-D-JCXAFw.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-CObHZeTA.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-BTXbCid6.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-BeBRmwkF.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-jsKSo8vc.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-t2gzTVU8.js";
import { t as buildOpenAIProvider } from "../../openai-provider-mL3OBD06.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-Btqc22e0.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-B2L4l4sO.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-CiaKaRKA.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-BMufUnTq.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-B4-6XTim.js";
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
