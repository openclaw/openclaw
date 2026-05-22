import { a as buildProviderToolCompatFamilyHooks } from "../../provider-tools-DgOkcG5J.js";
import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import { r as resolvePluginConfigObject } from "../../plugin-config-runtime-Beaulzon.js";
import { t as buildOpenAICodexCliBackend } from "../../cli-backend-ChAqrjY-.js";
import { t as buildOpenAIImageGenerationProvider } from "../../image-generation-provider-rahwHtEt.js";
import { n as openaiMediaUnderstandingProvider, t as openaiCodexMediaUnderstandingProvider } from "../../media-understanding-provider-C5J_lrnC.js";
import { t as openAiMemoryEmbeddingProviderAdapter } from "../../memory-embedding-adapter-BG_kb41O.js";
import { t as buildOpenAICodexProviderPlugin } from "../../openai-codex-provider-BUFFS89d.js";
import { t as buildOpenAIProvider } from "../../openai-provider-Cck9ymcT.js";
import { a as resolveOpenAISystemPromptContribution, i as resolveOpenAIPromptOverlayMode } from "../../prompt-overlay-78691cvH.js";
import { t as buildOpenAIRealtimeTranscriptionProvider } from "../../realtime-transcription-provider-C275Y4e2.js";
import { t as buildOpenAIRealtimeVoiceProvider } from "../../realtime-voice-provider-C_gQ6cqN.js";
import { t as buildOpenAISpeechProvider } from "../../speech-provider-CBxUFa2F.js";
import { t as buildOpenAIVideoGenerationProvider } from "../../video-generation-provider-v2BW-sxn.js";
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
