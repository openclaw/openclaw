import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-Djow_NXC.js";
import { t as definePluginEntry } from "../../plugin-entry-BzwFWtB2.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-27YfIt4P.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-DxTccPNM.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-DRBvLUcE.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-BM2cKp2d.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-CvsU1IW4.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-2d-sL1z6.js";
import { t as buildOpenAIProvider } from "../../openai-provider-BpD9AfE0.js";
import { i as resolveOpenAISystemPromptContribution, r as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-CDbvn-Dn.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-d7mMVrvT.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-6sie57uL.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-CdNFVWkk.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-Dkw6nOBF.js";
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
