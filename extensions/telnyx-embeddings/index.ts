import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { telnyxMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

export default definePluginEntry({
  id: "telnyx-embeddings",
  name: "Telnyx Embeddings",
  description: "Bundled Telnyx memory embedding provider plugin",
  register(api) {
    api.registerMemoryEmbeddingProvider(telnyxMemoryEmbeddingProviderAdapter);
  },
});
