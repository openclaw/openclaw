import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";
import { registerLlamaCppProvider } from "./src/managed-provider.js";
import { createLlamaCppMediaProvider } from "./src/media-provider.js";
import { registerLlamaCppMediaTool } from "./src/media-tool.js";

export default definePluginEntry({
  id: "llama-cpp",
  name: "llama.cpp Provider",
  description: "Managed and external llama.cpp servers for GGUF chat, embeddings and local images",
  register(api: OpenClawPluginApi) {
    const mediaProvider = createLlamaCppMediaProvider();
    api.registerEmbeddingProvider(llamaCppEmbeddingProviderAdapter);
    api.registerMediaUnderstandingProvider(mediaProvider);
    registerLlamaCppMediaTool(api, mediaProvider);
    registerLlamaCppProvider(api, mediaProvider);
  },
});
