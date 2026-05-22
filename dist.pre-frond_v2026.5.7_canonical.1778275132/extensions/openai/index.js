import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-B5Jc1Xdp.js";
import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-BDAD-n-2.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-jByAhBY5.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-iDNSy6f5.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-DtSsLMSU.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-4D_fHaaZ.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-4l4cBbkI.js";
import { t as buildOpenAIProvider } from "../../openai-provider-hLnpNLMF.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-3r0SkiZO.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-BXGUhoZX.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-C1OXpUqb.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-sYn_VqET.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-CWUP7miz.js";
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
