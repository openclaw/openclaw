import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-CWTapSmF.js";
import { t as definePluginEntry } from "../../plugin-entry-D9ROOnoR.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-CU9XZDAN.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-BUZJWz1U.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-dWuvsaUY.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-CK4E4Brq.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-C_gkvSXe.js";
import { t as buildOpenAIProvider } from "../../openai-provider-BJRKUnwG.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-Bfo2HQzj.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-Bt8oQezK.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-Bg31CEYi.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-DshGaUTb.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-BgC8jKP3.js";
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
