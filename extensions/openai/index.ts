import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  async register(api) {
    const {
      buildOpenAICodexCliBackend,
      buildOpenAICodexProviderPlugin,
      buildOpenAIImageGenerationProvider,
      buildOpenAIProvider,
      buildOpenAIRealtimeTranscriptionProvider,
      buildOpenAIRealtimeVoiceProvider,
      buildOpenAISpeechProvider,
      OPENAI_FRIENDLY_PROMPT_OVERLAY,
      openaiCodexMediaUnderstandingProvider,
      openaiMediaUnderstandingProvider,
      resolveOpenAIPromptOverlayMode,
      shouldApplyOpenAIPromptOverlay,
    } = await import("./register.runtime.js");

    const promptOverlayMode = resolveOpenAIPromptOverlayMode(api.pluginConfig);
    api.registerCliBackend(buildOpenAICodexCliBackend());
    api.registerProvider(buildOpenAIProvider());
    api.registerProvider(buildOpenAICodexProviderPlugin());
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider());
    api.registerRealtimeVoiceProvider(buildOpenAIRealtimeVoiceProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
    api.registerMediaUnderstandingProvider(openaiCodexMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    if (promptOverlayMode !== "off") {
      api.on("before_prompt_build", (_event, ctx) =>
        shouldApplyOpenAIPromptOverlay({
          mode: promptOverlayMode,
          modelProviderId: ctx.modelProviderId,
        })
          ? { appendSystemContext: OPENAI_FRIENDLY_PROMPT_OVERLAY }
          : undefined,
      );
    }
  },
});
