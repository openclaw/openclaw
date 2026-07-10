import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { llamaCppEmbeddingProviderAdapter } from "./src/embedding-provider.js";

export default definePluginEntry({
  id: "llama-cpp",
  name: "llama.cpp Provider",
  description: "Local GGUF embeddings through node-llama-cpp",
  register(api) {
    api.registerEmbeddingProvider(llamaCppEmbeddingProviderAdapter);
  },
});
