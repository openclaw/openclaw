import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-hBAo_eaK.js";
import { t as definePluginEntry } from "../../plugin-entry-uVlVsnaB.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-DziXNF-b.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-DLKfjor_.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-Du4dhYO6.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-DnGmAtI6.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-DrqmsiKZ.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-Cb20ASmi.js";
import { t as buildOpenAIProvider } from "../../openai-provider-DJHxXBy4.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-BHA5hb2n.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-CnHTGB0F.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-Xt9NzN0m.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-dJ1gMUzB.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-C9OJaZlX.js";
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
