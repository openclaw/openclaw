import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-DuUThUWN.js";
import { t as definePluginEntry } from "../../plugin-entry-6pkoHhQg.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-BANFJK51.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-BrLQ7mOG.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-w_GdGJUd.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-CtYcTklK.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-w67oKuLR.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-C2Cvkquq.js";
import { t as buildOpenAIProvider } from "../../openai-provider-Cdp_Fy7Z.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-BuVfGZ7C.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CSUNWDeT.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-DgKSwfYW.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-S6ZJoPag.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-DLxE9blx.js";
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
