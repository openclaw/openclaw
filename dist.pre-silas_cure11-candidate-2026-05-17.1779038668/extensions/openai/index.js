import { t as buildProviderToolCompatFamilyHooks } from "../../provider-tools-DbsHzhxk.js";
import { t as definePluginEntry } from "../../plugin-entry-CvekifYj.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-xelKJyk4.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-D8qz7Qhs.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-mrs4H7cg.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-VH1YWHtg.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-BECPf210.js";
import { t as buildOpenAIProvider } from "../../openai-provider-Ca9WJFdS.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-jKT38x0d.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-UUnH4rFS.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-Dbejc45n.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-Clcw4vV0.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-CmmlEmb1.js";
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
