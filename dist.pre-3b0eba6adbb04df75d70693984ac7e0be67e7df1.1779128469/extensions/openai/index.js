import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-jCX0w-QE.js";
import { t as definePluginEntry } from "../../plugin-entry-BHxvLKTc.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-BSshwjRE.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-BnFV5Ci8.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-Dp-LnczL.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-Bj32bFdV.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-BPPNPuZq.js";
import { t as buildOpenAIProvider } from "../../openai-provider-DqW3THeN.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-D-5bQV8M.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CfD51jh-.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-DlSpTTme.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-CF-l4g_G.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-C8_sBR1q.js";
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
