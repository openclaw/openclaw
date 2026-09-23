import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createLazyRuntimeSurface } from "openclaw/plugin-sdk/lazy-runtime";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type { MusicGenerationProvider } from "openclaw/plugin-sdk/music-generation";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import {
  createGoogleImageGenerationProviderMetadata,
  createGoogleMediaUnderstandingProviderMetadata,
  createGoogleMusicGenerationProviderMetadata,
  createGoogleVideoGenerationProviderMetadata,
} from "./generation-provider-metadata.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { registerGoogleProvider } from "./provider-registration.js";
import { createLazyGoogleRealtimeVoiceProvider } from "./realtime-voice-lazy.js";
import { buildGoogleSpeechProvider } from "./speech-provider.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

type GoogleMediaUnderstandingProvider = Required<
  Pick<MediaUnderstandingProvider, "transcribeAudio" | "describeVideo">
>;

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

async function loadGoogleRequiredMediaUnderstandingProvider(): Promise<GoogleMediaUnderstandingProvider> {
  const provider = await loadGoogleMediaUnderstandingProvider();
  if (!provider.transcribeAudio || !provider.describeVideo) {
    throw new Error("google media understanding provider missing required handlers");
  }
  return provider as GoogleMediaUnderstandingProvider;
}

function createLazyGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    ...createGoogleImageGenerationProviderMetadata(),
    generateImage: async (req) => (await loadGoogleImageGenerationProvider()).generateImage(req),
  };
}

function createLazyGoogleMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    ...createGoogleMediaUnderstandingProviderMetadata(),
    transcribeAudio: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).transcribeAudio(...args),
    describeVideo: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeVideo(...args),
  };
}

function createLazyGoogleMusicGenerationProvider(): MusicGenerationProvider {
  return {
    ...createGoogleMusicGenerationProviderMetadata(),
    generateMusic: async (...args) =>
      await (await loadGoogleMusicGenerationProvider()).generateMusic(...args),
  };
}

function createLazyGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createGoogleVideoGenerationProviderMetadata(),
    generateVideo: async (...args) =>
      await (await loadGoogleVideoGenerationProvider()).generateVideo(...args),
  };
}

export default definePluginEntry({
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
    registerGoogleGeminiCliProvider(api);
    registerGoogleProvider(api);
    api.registerEmbeddingProvider(geminiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());
    api.registerMediaUnderstandingProvider(createLazyGoogleMediaUnderstandingProvider());
    api.registerMusicGenerationProvider(createLazyGoogleMusicGenerationProvider());
    api.registerRealtimeVoiceProvider(createLazyGoogleRealtimeVoiceProvider());
    api.registerSpeechProvider(buildGoogleSpeechProvider());
    api.registerVideoGenerationProvider(createLazyGoogleVideoGenerationProvider());
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
