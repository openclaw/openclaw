import { o as SsrFPolicy } from "../../ssrf-B2gz_4IH.js";
import { Ei as MemoryEmbeddingProviderCreateOptions, wi as MemoryEmbeddingProvider } from "../../types-lCXG2pW_.js";
//#region extensions/mistral/embedding-provider.d.ts
type MistralEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  model: string;
};
declare const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
declare function createMistralEmbeddingProvider(options: MemoryEmbeddingProviderCreateOptions): Promise<{
  provider: MemoryEmbeddingProvider;
  client: MistralEmbeddingClient;
}>;
//#endregion
export { DEFAULT_MISTRAL_EMBEDDING_MODEL, createMistralEmbeddingProvider };