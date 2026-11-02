export { DEFAULT_OLLAMA_EMBEDDING_MODEL } from "./defaults.js";
export type {
  OllamaEmbeddingClient,
  OllamaEmbeddingProvider,
} from "./embedding-provider.runtime.js";

type OllamaEmbeddingRuntime = typeof import("./embedding-provider.runtime.js");

export const createOllamaEmbeddingProvider: OllamaEmbeddingRuntime["createOllamaEmbeddingProvider"] =
  async (...args) =>
    await (await import("./embedding-provider.runtime.js")).createOllamaEmbeddingProvider(...args);
