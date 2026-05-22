import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-B6vtw4BW.js";
import { t as definePluginEntry } from "../../plugin-entry-CEeEexhG.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-Bo1W4ejv.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-CCrWwWPa.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-D-6Bs5cR.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-DypVgJxB.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-odryok7U.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-fvfBOA-j.js";
import { t as buildOpenAIProvider } from "../../openai-provider-QDOTfV8P.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-BilUwxoa.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-DUArVRKq.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-Bm8yX8ki.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-BrpHtcCQ.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-CaeLRLN4.js";
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
