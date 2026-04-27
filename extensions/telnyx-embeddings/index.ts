import { definePluginEntry } from "openclaw/plugin-sdk";
import { telnyxMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

export default definePluginEntry({
  registerMemoryEmbeddingProvider: () => telnyxMemoryEmbeddingProviderAdapter,
});
