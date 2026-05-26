import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-CWTapSmF.js";
import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-DyMlx_D0.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-D4q7sZcK.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-B27rK5IY.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-D6fbLAPd.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-_A2FF1bJ.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-CTHeSiji.js";
import { t as buildOpenAIProvider } from "../../openai-provider-BTwaWxlI.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-D0TXHKDn.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CYEYHkQ6.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-B0fB2wLH.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-B-RyuKLK.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-CbObl_3x.js";
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
