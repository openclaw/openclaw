import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-CUksBU_o.js";
import { t as definePluginEntry } from "../../plugin-entry-CdPayZCH.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-LLpKGq7R.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-BUlZKLlm.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-CHNG5f4Z.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-hB3P9G8r.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-D2YdVTu_.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-Drr19PHF.js";
import { t as buildOpenAIProvider } from "../../openai-provider-BfwAA6c-.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-DCGnYzb_.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-Bq5Q7smg.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-BacPaS1s.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-BOYuk9x-.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-CddgFpT_.js";
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
