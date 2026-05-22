import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-BTWF-rOZ.js";
import { t as definePluginEntry } from "../../plugin-entry-DeObqXcQ.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-CJkf30el.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-CR3KE9v0.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-DJs36olR.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-qOuXotjs.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-DlaeIPIs.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-doig1GaT.js";
import { t as buildOpenAIProvider } from "../../openai-provider-DKlIffqi.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-dz2I5z_u.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-BkQIV3HA.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-mdtUyFWE.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-BWI2HojJ.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-C-iFIhXV.js";
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
