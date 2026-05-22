import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-CrFUFzOu.js";
import { t as definePluginEntry } from "../../plugin-entry-Cq3HIsoQ.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime--BJVVJOK.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-DvPWUxJy.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-BiImpznY.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-hdKP8bO7.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-BkG1wKDE.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-DG8vQvGt.js";
import { t as buildOpenAIProvider } from "../../openai-provider-qsOJz-3w.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-D7IdwUEr.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-2s5NVWqF.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-DQYxljRV.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-CvYmCNBS.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-D_NchlB2.js";
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
