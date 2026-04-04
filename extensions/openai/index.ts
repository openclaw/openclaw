import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICodexCliBackend } from "./cli-backend.js";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  openaiCodexMediaUnderstandingProvider,
  openaiMediaUnderstandingProvider,
} from "./media-understanding-provider.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import {
  OPENAI_FRIENDLY_PROMPT_OVERLAY,
  resolveOpenAIPromptOverlayMode,
  shouldApplyOpenAIPromptOverlay,
} from "./prompt-overlay.js";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
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
