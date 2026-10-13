import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildMinimaxImageGenerationProvider } from "./image-generation-provider.js";
import {
  minimaxMediaUnderstandingProvider,
  minimaxPortalMediaUnderstandingProvider,
} from "./media-understanding-provider.js";
import { buildMinimaxMusicGenerationProvider } from "./music-generation-provider.js";
import { registerMinimaxProviders } from "./provider-registration.js";
import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";
import { createMiniMaxWebSearchProvider } from "./src/minimax-web-search-provider.js";
import { buildMinimaxVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "minimax",
  name: "MiniMax",
  description: "Bundled MiniMax API-key and OAuth provider plugin",
  register(api) {
    registerMinimaxProviders(api);
    api.registerMediaUnderstandingProvider(minimaxMediaUnderstandingProvider);
    api.registerMediaUnderstandingProvider(minimaxPortalMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildMinimaxImageGenerationProvider());
    api.registerImageGenerationProvider(buildMinimaxImageGenerationProvider("minimax-portal"));
    api.registerMusicGenerationProvider(buildMinimaxMusicGenerationProvider());
    api.registerMusicGenerationProvider(buildMinimaxMusicGenerationProvider("minimax-portal"));
    api.registerVideoGenerationProvider(buildMinimaxVideoGenerationProvider());
    api.registerVideoGenerationProvider(buildMinimaxVideoGenerationProvider("minimax-portal"));
    api.registerSpeechProvider(buildMinimaxSpeechProvider);
    api.registerWebSearchProvider(createMiniMaxWebSearchProvider());
  },
});
