import { n as buildProviderToolCompatFamilyHooks } from "../../provider-tools-D8Ja_oUH.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-DWa7yCpn.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-DyUnxpyv.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-DGlQQocD.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-EOGIPOrG.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-Ctr20mI5.js";
import { t as buildOpenAIProvider } from "../../openai-provider-B0CC7P07.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-jwXIfArS.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-BTAuWRpS.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-DCrldkS6.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-CHJ5qd_z.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-BiaGd3Mr.js";
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
