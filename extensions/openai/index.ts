import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  async register(api) {
    const { buildOpenAICodexCliBackend } = await import("./cli-backend.js");
    const { buildOpenAICodexProviderPlugin } = await import("./openai-codex-provider.js");
    const { buildOpenAIProvider } = await import("./openai-provider.js");
    const {
      OPENAI_FRIENDLY_PROMPT_OVERLAY,
      resolveOpenAIPromptOverlayMode,
      shouldApplyOpenAIPromptOverlay,
    } = await import("./prompt-overlay.js");
    const registerOptional = async (registerFn: () => Promise<void>) => {
      try {
        await registerFn();
      } catch {
        // Optional OpenAI surfaces must not block core provider registration.
      }
    };

    const promptOverlayMode = resolveOpenAIPromptOverlayMode(api.pluginConfig);
    api.registerCliBackend(buildOpenAICodexCliBackend());
    api.registerProvider(buildOpenAIProvider());
    api.registerProvider(buildOpenAICodexProviderPlugin());
    await registerOptional(async () => {
      const { buildOpenAIImageGenerationProvider } = await import("./image-generation-provider.js");
      api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    });
    await registerOptional(async () => {
      const { buildOpenAIRealtimeTranscriptionProvider } =
        await import("./realtime-transcription-provider.js");
      api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider());
    });
    await registerOptional(async () => {
      const { buildOpenAIRealtimeVoiceProvider } = await import("./realtime-voice-provider.js");
      api.registerRealtimeVoiceProvider(buildOpenAIRealtimeVoiceProvider());
    });
    await registerOptional(async () => {
      const { buildOpenAISpeechProvider } = await import("./speech-provider.js");
      api.registerSpeechProvider(buildOpenAISpeechProvider());
    });
    await registerOptional(async () => {
      const { openaiMediaUnderstandingProvider, openaiCodexMediaUnderstandingProvider } =
        await import("./media-understanding-provider.js");
      api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
      api.registerMediaUnderstandingProvider(openaiCodexMediaUnderstandingProvider);
    });
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
