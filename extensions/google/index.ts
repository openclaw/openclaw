import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { buildGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import {
  createGoogleImageGenerationProviderMetadata,
  createGoogleMediaUnderstandingProviderMetadata,
  createGoogleMusicGenerationProviderMetadata,
  createGoogleVideoGenerationProviderMetadata,
} from "./generation-provider-metadata.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { buildGoogleProvider } from "./provider-registration.js";
import { createLazyGoogleRealtimeVoiceProvider } from "./realtime-voice-lazy.js";
import { buildGoogleSpeechProvider } from "./speech-provider.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

const loadGoogleImageGenerationProvider = createLazyRuntimeSurface(
  () => import("./image-generation-provider.js"),
  (mod) => mod.buildGoogleImageGenerationProvider(),
);

const loadGoogleMediaUnderstandingProvider = createLazyRuntimeSurface(
  () => import("./media-understanding-provider.js"),
  (mod) => mod.googleMediaUnderstandingProvider,
);

const loadGoogleMusicGenerationProvider = createLazyRuntimeSurface(
  () => import("./music-generation-provider.js"),
  (mod) => mod.buildGoogleMusicGenerationProvider(),
);

const loadGoogleVideoGenerationProvider = createLazyRuntimeSurface(
  () => import("./video-generation-provider.js"),
  (mod) => mod.buildGoogleVideoGenerationProvider(),
);

export default definePluginEntry({
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
    api.registerProvider(buildGoogleGeminiCliProvider());
    api.registerProvider(buildGoogleProvider());
    api.registerEmbeddingProvider(geminiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider({
      ...createGoogleImageGenerationProviderMetadata(),
      generateImage: async (req) => (await loadGoogleImageGenerationProvider()).generateImage(req),
    });
    api.registerMediaUnderstandingProvider({
      ...createGoogleMediaUnderstandingProviderMetadata(),
      transcribeAudio: async (...args) =>
        (await loadGoogleMediaUnderstandingProvider()).transcribeAudio(...args),
      describeVideo: async (...args) =>
        (await loadGoogleMediaUnderstandingProvider()).describeVideo(...args),
    });
    api.registerMusicGenerationProvider({
      ...createGoogleMusicGenerationProviderMetadata(),
      generateMusic: async (req) => (await loadGoogleMusicGenerationProvider()).generateMusic(req),
    });
    api.registerRealtimeVoiceProvider(createLazyGoogleRealtimeVoiceProvider());
    api.registerSpeechProvider(buildGoogleSpeechProvider());
    api.registerVideoGenerationProvider({
      ...createGoogleVideoGenerationProviderMetadata(),
      generateVideo: async (req) => (await loadGoogleVideoGenerationProvider()).generateVideo(req),
    });
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
