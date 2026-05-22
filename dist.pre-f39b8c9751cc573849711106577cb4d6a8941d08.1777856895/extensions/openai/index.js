import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-CBVNkL6v.js";
import { t as definePluginEntry } from "../../plugin-entry-Qint-vYf.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-Cw3yGmqP.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-SMp-uvS0.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-zp1Up_8S.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-C00R0Eh8.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-DmawlU3l.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-B8Q2oOTh.js";
import { t as buildOpenAIProvider } from "../../openai-provider-DTpI8F3_.js";
import { i as resolveOpenAISystemPromptContribution, r as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-DpP1iE3N.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-lUnjYyx3.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-Dk8nMMY1.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-B6FC80BP.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-DUof3RpZ.js";
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
					modelId: ctx.modelId
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
