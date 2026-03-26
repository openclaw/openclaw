import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICodexCliBackend } from "./cli-backend.js";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  openaiCodexMediaUnderstandingProvider,
  openaiMediaUnderstandingProvider,
} from "./media-understanding-provider.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    api.registerCliBackend(buildOpenAICodexCliBackend());
    api.registerProvider(buildOpenAIProvider());
    api.registerProvider(buildOpenAICodexProviderPlugin());
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
    api.registerMediaUnderstandingProvider(openaiCodexMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
  },
});
