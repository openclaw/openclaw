import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-2EF_PdCY.js";
import { t as definePluginEntry } from "../../plugin-entry-SrJZmI2E.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-727Z09T1.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-DVsUnnpg.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-CLKEOQRp.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-Dokt0w2u.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-GD4B5Epu.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-BsJqqTFs.js";
import { t as buildOpenAIProvider } from "../../openai-provider-D-iqjSMQ.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-DD7dlwSx.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CFZntqk9.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-Djrc6upm.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-BHuD05e6.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-hlUt-ALQ.js";
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
