import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-jCX0w-QE.js";
import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-BSshwjRE.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-EvMQ44If.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-DLaiNN_J.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-D5XzCeaK.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-hJPbFqY3.js";
import { t as buildOpenAIProvider } from "../../openai-provider-C_fKZaEp.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-RIeHYcYd.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DpWOGRcU.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-BaLui7dC.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-_99gv58J.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-CjIbekFk.js";
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
