import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./defaults.js";
import { OLLAMA_PROVIDER_ID } from "./discovery-shared.js";

// The EmbeddingGemma prefix rule from memory-host-sdk embedding-inputs, narrowed to v2;
// EmbeddingGemma 1 embeds text only.
const EMBEDDINGGEMMA_2_MODEL = /(?:^|[/\\])(?:text-embedding-)?embeddinggemma-2(?::([^/\\]*))?$/iu;

/** Ollama's embeddinggemma-2 tags load encoders by size: 270m text, 440m +vision, 570m +audio. */
function resolveOllamaEmbeddingMediaModalities({
  model,
}: {
  model: string;
}): Array<"image" | "audio"> {
  const match = EMBEDDINGGEMMA_2_MODEL.exec(model.trim());
  if (!match) {
    return [];
  }
  const size = match[1]?.split("-")[0];
  // Unknown future tags stay text only until their encoders are known.
  if (size === undefined || size === "" || size === "latest" || size === "740m") {
    return ["image", "audio"];
  }
  return size === "440m" ? ["image"] : size === "570m" ? ["audio"] : [];
}

const loadOllamaMemoryEmbeddingProviderAdapter = createLazyRuntimeModule(
  async () => (await import("./memory-embedding-adapter.js")).ollamaMemoryEmbeddingProviderAdapter,
);

/** Registered adapter: memory reads media support synchronously, before the runtime loads. */
export const lazyOllamaMemoryEmbeddingProviderAdapter: MemoryEmbeddingProviderAdapter = {
  id: OLLAMA_PROVIDER_ID,
  defaultModel: DEFAULT_OLLAMA_EMBEDDING_MODEL,
  transport: "remote",
  authProviderId: OLLAMA_PROVIDER_ID,
  mediaModalities: resolveOllamaEmbeddingMediaModalities,
  create: async (options) =>
    await (await loadOllamaMemoryEmbeddingProviderAdapter()).create(options),
};
