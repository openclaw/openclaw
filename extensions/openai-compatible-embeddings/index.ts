import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { openaiCompatibleMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

export default definePluginEntry({
  id: "openai-compatible-embeddings",
  name: "OpenAI-compatible Embeddings",
  description:
    "Embedding provider for any local OpenAI-compatible HTTP server (llama.cpp's llama-server, Ollama via /v1, vLLM, TGI, LocalAI, llamafile). No vendor-specific warmup, no global config inheritance.",
  register(api: OpenClawPluginApi) {
    api.registerMemoryEmbeddingProvider(openaiCompatibleMemoryEmbeddingProviderAdapter);
  },
});
